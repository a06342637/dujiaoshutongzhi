import type { Config } from './config.js';
import type { Product, Scan, SKU, Stock, StockStatus } from './types.js';
import { VERSION } from './version.js';

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {};
export function localized(x: unknown): string {
  if (typeof x === 'string') return x;
  const o = obj(x);
  const selected =
    o['zh-CN'] ||
    o['zh'] ||
    o['en-US'] ||
    o['en'] ||
    Object.values(o).find((v) => typeof v === 'string' && v);
  return typeof selected === 'string' ? selected : '';
}
function quantity(x: unknown): number | null {
  if (typeof x !== 'number' && typeof x !== 'string') return null;
  if (typeof x === 'string' && !/^-?\d+$/.test(x)) return null;
  const n = Number(x);
  return Number.isSafeInteger(n) && n >= -1 ? n : null;
}
function status(x: unknown): StockStatus | null {
  return x === 'out_of_stock' ? 'out' : x === 'low_stock' ? 'low' : x === 'in_stock' ? 'in' : null;
}
export function normalizeStock(raw: Obj, type: string, sku = false, parent?: Obj): Stock {
  const reported = raw.stock_status;
  if (reported === 'unlimited') return { kind: 'unlimited' };
  const st = status(reported) ?? (raw.is_sold_out === true ? 'out' : null);
  const hidden =
    raw.stock_quantity_hidden === true ||
    parent?.stock_quantity_hidden === true ||
    (typeof raw.stock_display_mode === 'string' && raw.stock_display_mode !== 'exact') ||
    (typeof parent?.stock_display_mode === 'string' && parent.stock_display_mode !== 'exact');
  if (hidden) {
    const min = quantity(raw.stock_range_min),
      max = quantity(raw.stock_range_max);
    if (
      typeof raw.stock_display === 'string' &&
      raw.stock_display.startsWith('range_') &&
      min !== null &&
      min > 0 &&
      (max === null || max >= min)
    )
      return { kind: 'range', min, max, status: st ?? 'in' };
    return { kind: 'hidden', status: st };
  }
  const field =
    type === 'upstream' && sku
      ? 'upstream_stock'
      : type === 'auto'
        ? 'auto_stock_available'
        : sku
          ? 'manual_stock_total'
          : 'manual_stock_available';
  const n = quantity(raw[field]);
  if (n === null) return { kind: 'unknown' };
  if (n === -1) return { kind: 'unlimited' };
  // Contradictory public data is not reliable evidence of sold-out inventory.
  if ((n === 0 && (st === 'in' || st === 'low')) || (n > 0 && st === 'out'))
    return { kind: 'unknown' };
  return { kind: 'exact', quantity: n, status: n === 0 ? 'out' : (st ?? (n <= 5 ? 'low' : 'in')) };
}
function price(raw: Obj) {
  const p = raw.promotion_price_amount ?? raw.price_amount;
  if ((typeof p !== 'string' && typeof p !== 'number') || !/^\d+(?:\.\d+)?$/.test(String(p)))
    throw new Error('商品公开价格字段无效');
  return String(p);
}
function identity(v: unknown) {
  const s = String(v);
  if (!/^\d{1,30}$/.test(s)) throw new Error('商品或规格 ID 无效');
  return s;
}
function specs(value: unknown): string {
  const values = obj(value),
    preferred = values['zh-CN'] ?? values['zh'] ?? values['en-US'] ?? values['en'];
  if (typeof preferred === 'string') return preferred;
  const selected = preferred && typeof preferred === 'object' ? obj(preferred) : values;
  return Object.entries(selected)
    .map(([key, v]) => {
      const text = localized(v) || (typeof v === 'number' ? String(v) : '');
      return text ? `${key}: ${text}` : '';
    })
    .filter(Boolean)
    .join(' / ');
}
export function normalizeProduct(value: unknown): Product {
  const p = obj(value),
    id = identity(p.id);
  if (typeof p.slug !== 'string' || !p.slug || !p.title || !Array.isArray(p.skus))
    throw new Error(`商品 ${id} 结构不兼容 v1.5.0`);
  const type = String(p.fulfillment_type || 'manual');
  const skus: SKU[] = p.skus
    .filter((x) => obj(x).is_active !== false)
    .map((x) => {
      const s = obj(x);
      const name = specs(s.spec_values) || String(s.sku_code || '默认规格');
      return { id: identity(s.id), name, price: price(s), stock: normalizeStock(s, type, true, p) };
    });
  if (new Set(skus.map((s) => s.id)).size !== skus.length)
    throw new Error(`商品 ${id} 规格 ID 重复`);
  return {
    id,
    slug: p.slug,
    name: localized(p.title) || p.slug,
    categoryId: String(p.category_id ?? ''),
    categoryName: localized(obj(p.category).name),
    price: price(p),
    priceFrom: new Set(skus.map((s) => Number(s.price))).size > 1,
    stock: normalizeStock(p, type),
    skus,
  };
}
export function apiBase(c: Config) {
  const base = (c.apiUrl || `${c.siteUrl.replace(/\/+$/, '')}/api/v1`).replace(/\/+$/, '');
  return base.endsWith('/public') ? base.slice(0, -7) : base;
}
export class FetchError extends Error {
  constructor(
    message: string,
    readonly retryAfter = 0,
    readonly retryable = true,
  ) {
    super(message);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function limitedJSON(response: Response) {
  if (!response.body) throw new FetchError('网站返回空响应');
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8 * 1024 * 1024)
        throw new FetchError('单页响应超过 8MB，请降低网站单商品内容大小', 0, false);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return obj(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError('接口未返回 JSON，可能是防火墙验证页或 API 地址错误', 0, false);
  }
}
export class DujiaoAdapter {
  private cached: { key: string; at: number; siteName: string; currency: string } | undefined;
  constructor(
    private fetcher: typeof fetch = fetch,
    private wait = sleep,
  ) {}
  private async request(url: string, c: Config): Promise<Obj> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(url, {
          headers: { accept: 'application/json', 'user-agent': `DujiaoStockBot/${VERSION}` },
          signal: AbortSignal.timeout(c.timing.timeout * 1000),
          redirect: 'follow',
        });
        if (!response.ok) {
          const retry = response.headers.get('retry-after');
          const delay = retry
            ? Number.isFinite(Number(retry))
              ? Number(retry) * 1000
              : Math.max(0, Date.parse(retry) - Date.now())
            : 0;
          await response.body?.cancel();
          throw new FetchError(
            `网站接口 HTTP ${response.status}`,
            Math.min(delay || 0, 86400000),
            response.status === 429 || response.status >= 500,
          );
        }
        const json = await limitedJSON(response);
        if (json.status_code !== 0) throw new FetchError('网站接口业务状态异常', 0, false);
        return json;
      } catch (e) {
        const error =
          e instanceof FetchError
            ? e
            : new FetchError(
                e instanceof Error && e.name === 'TimeoutError' ? '网站请求超时' : '网站连接失败',
              );
        if (attempt >= c.timing.retries || !error.retryable || error.retryAfter > 30000)
          throw error;
        await this.wait(Math.max(error.retryAfter, 1000 * 2 ** attempt));
      }
    }
  }
  async scan(c: Config): Promise<Scan> {
    if (!c.siteUrl) throw new Error('尚未设置店铺网址');
    const base = apiBase(c),
      key = `${c.siteUrl}|${base}`;
    if (!this.cached || this.cached.key !== key || Date.now() - this.cached.at > 300000) {
      const config = obj((await this.request(`${base}/public/config`, c)).data);
      const categories = (await this.request(`${base}/public/categories`, c)).data;
      if (!Array.isArray(categories)) throw new FetchError('分类接口结构异常', 0, false);
      const currency = String(config.currency || '');
      if (!/^[A-Z]{3}$/.test(currency))
        throw new FetchError('网站币种字段缺失，请检查 API 地址', 0, false);
      this.cached = {
        key,
        at: Date.now(),
        siteName: localized(config.site_name) || new URL(c.siteUrl).hostname,
        currency,
      };
    }
    const products: Product[] = [];
    let total: number | undefined,
      pages = 0;
    const seen = new Set<string>();
    for (let page = 1; page <= 1000; page++) {
      const json = await this.request(`${base}/public/products?page=${page}&page_size=100`, c);
      if (!Array.isArray(json.data)) throw new FetchError('商品列表结构异常', 0, false);
      const pagination = obj(json.pagination);
      const currentTotal = quantity(pagination.total);
      if (currentTotal === null || currentTotal < 0)
        throw new FetchError('分页总数缺失，拒绝使用不完整快照', 0, false);
      if (total !== undefined && total !== currentTotal)
        throw new FetchError('翻页期间商品总数变化，将重新检查');
      total = currentTotal;
      pages++;
      for (const value of json.data) {
        const product = normalizeProduct(value);
        if (seen.has(product.id)) throw new FetchError('分页商品重复，将重新检查');
        seen.add(product.id);
        products.push(product);
      }
      if (products.length === total) break;
      if (!json.data.length || products.length > total || page === 1000)
        throw new FetchError('商品分页不完整，保留上次库存');
    }
    return {
      products,
      pages,
      at: Date.now(),
      siteName: this.cached.siteName,
      currency: this.cached.currency,
    };
  }
}
