import { eventLabels, isEnabled, type Config, type Format } from './config.js';
import { isAvailable, isOut } from './engine.js';
import { orderProducts } from './sorting.js';
import type { Button, Change, MessagePayload, Product, Stock } from './types.js';

export const escapeHTML = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
export const templateVariables = [
  'site',
  'time',
  'product',
  'spec',
  'spec_line',
  'price',
  'stock',
  'before',
  'after',
  'delta',
  'delta_text',
  'event',
  'url',
  'emoji',
  'details',
  'header',
  'top',
  'divider',
  'stock_title',
  'footer',
  'details_title',
  'page',
  'pages',
];
export function validateHTML(html: string) {
  const stack: string[] = [];
  for (const match of html.matchAll(/<[^>]*>|[<>]/g)) {
    const tag = match[0],
      close = /^<\//.test(tag),
      name = /^<\/?([a-z-]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (
      !name ||
      ![
        'b',
        'strong',
        'i',
        'em',
        'u',
        'ins',
        's',
        'strike',
        'del',
        'code',
        'pre',
        'blockquote',
        'tg-spoiler',
        'a',
        'tg-emoji',
      ].includes(name)
    )
      throw new Error('模板只支持 Telegram HTML 标签，不支持脚本、图片或其他网页标签');
    if (close) {
      if (tag !== `</${name}>` || stack.pop() !== name) throw new Error('模板 HTML 标签未正确配对');
      continue;
    }
    if (
      (name === 'a' && stack.includes('a')) ||
      (name === 'blockquote' && stack.includes('blockquote'))
    )
      throw new Error('链接和引用不能同类嵌套');
    if (
      stack.includes('code') ||
      stack.includes('tg-emoji') ||
      (stack.includes('pre') && name !== 'code')
    )
      throw new Error('代码和自定义表情内部不能嵌套格式标签');
    if (name === 'a') {
      const href = /^<a href="([^"<>]+)">$/.exec(tag)?.[1];
      if (!href) throw new Error('链接格式必须为 <a href="https://...">文字</a>');
      try {
        const u = new URL(href.replace(/&amp;/g, '&'));
        if (!['http:', 'https:', 'tg:'].includes(u.protocol) || u.username || u.password) throw 0;
      } catch {
        throw new Error('模板链接地址无效');
      }
    } else if (name === 'tg-emoji') {
      if (!/^<tg-emoji emoji-id="\d{1,30}">$/.test(tag))
        throw new Error('自定义表情标签缺少有效 ID');
    } else if (name === 'blockquote') {
      if (tag !== '<blockquote>' && tag !== '<blockquote expandable>')
        throw new Error('引用标签格式无效');
    } else if (tag !== `<${name}>`) throw new Error('该标签不支持属性');
    stack.push(name);
    if (stack.length > 8) throw new Error('模板标签嵌套不能超过 8 层');
  }
  if (stack.length) throw new Error('模板 HTML 标签未闭合');
  if (/&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);)/i.test(html))
    throw new Error('模板中的 & 请写成 &amp;');
}
export function template(
  source: string,
  values: Record<string, unknown>,
  trusted: string[] = [],
): string {
  return source.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`不支持的模板变量：{${key}}`);
    return trusted.includes(key) ? String(values[key] ?? '') : escapeHTML(values[key]);
  });
}
const globalVariables = ['site', 'time', 'page', 'pages'];
const changeVariables = [
  ...globalVariables,
  'product',
  'spec',
  'spec_line',
  'price',
  'stock',
  'before',
  'after',
  'delta',
  'delta_text',
  'event',
  'url',
  'emoji',
];
export function validateAppearance(c: Config) {
  const check = (s: string, allowed: string[], html = true) => {
    for (const m of s.matchAll(/\{([a-z_]+)\}/g))
      if (!allowed.includes(m[1]!)) throw new Error(`此位置不支持变量 {${m[1]}}`);
    if (html) {
      const dummy = Object.fromEntries(
        allowed.map((k) => [
          k,
          k === 'url' ? 'https://example.com' : k === 'emoji' ? '📦' : '示例',
        ]),
      );
      validateHTML(template(s, dummy));
    }
  };
  for (const f of [c.appearance.notification, c.appearance.board]) {
    for (const k of ['header', 'top', 'detailsTitle', 'divider', 'stockTitle', 'footer'] as const)
      check(f[k], globalVariables);
    check(f.changeTemplate, changeVariables);
    check(f.bodyTemplate, [
      ...globalVariables,
      'details',
      'header',
      'top',
      'divider',
      'stock_title',
      'footer',
      'details_title',
    ]);
  }
  check(c.appearance.buttonTemplate, ['product', 'spec', 'price', 'stock', 'emoji'], false);
  if (!c.appearance.buttonTemplate.trim()) throw new Error('商品按钮模板不能为空');
}
export function stockText(s: Stock): string {
  switch (s.kind) {
    case 'exact':
      return s.quantity === 0 ? '已售罄' : `可售 ${s.quantity}`;
    case 'unlimited':
      return '无限';
    case 'unknown':
      return '未知';
    case 'hidden':
      return s.status === 'out'
        ? '已售罄'
        : s.status === 'low'
          ? '库存紧张'
          : s.status === 'in'
            ? '有货'
            : '数量隐藏';
    case 'range':
      return s.status === 'out'
        ? '已售罄'
        : s.max === null
          ? `${s.min}+ 件`
          : `${s.min}～${s.max} 件`;
  }
}
const shortStock = (s: Stock) => (s.kind === 'exact' ? String(s.quantity) : stockText(s));
export function formattedTime(at: number, f: Format) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: f.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return f.timeFormat
    .replace('YYYY', p.year!)
    .replace('MM', p.month!)
    .replace('DD', p.day!)
    .replace('HH', p.hour!)
    .replace('mm', p.minute!)
    .replace('ss', p.second!);
}
export function money(price: string, currency: string) {
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 8,
    }).format(Number(price));
  } catch {
    return `${currency} ${price}`;
  }
}
function productURL(c: Config, p: Product) {
  return (
    c.products[p.id]?.url ||
    `${c.siteUrl.replace(/\/+$/, '')}/products/${encodeURIComponent(p.slug)}`
  );
}
function emoji(c: Config, id: string, rich = false) {
  const setting = c.products[id];
  const fallback = setting?.emoji ?? c.appearance.emoji;
  const custom = setting?.customEmojiId ?? c.appearance.customEmojiId;
  return rich && custom
    ? `<tg-emoji emoji-id="${custom}">${escapeHTML(fallback || '📦')}</tg-emoji>`
    : rich
      ? escapeHTML(fallback)
      : fallback;
}
function buttonStyle(style: Config['appearance']['style'], stock: Stock): Button['style'] {
  if (style === 'default') return undefined;
  if (style !== 'auto') return style;
  return isOut(stock) ? 'danger' : isAvailable(stock) ? 'success' : 'primary';
}
export function sortedProducts(products: Product[], c: Config) {
  return orderProducts(
    products.filter((p) => isEnabled(c, p.id)),
    c,
  );
}
function clip(s: string, max = 110) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}
export function productButtons(products: Product[], c: Config, currency: string): Button[][] {
  const rows: Button[][] = [];
  for (const p of products) {
    const override = c.products[p.id];
    const entries =
      override?.expandSkus && p.skus.length
        ? p.skus.map((s) => ({
            name: `${override?.name || p.name} · ${s.name}`,
            spec: s.name,
            stock: s.stock,
            price: s.price,
            from: false,
          }))
        : [
            {
              name: override?.name || p.name,
              spec: '',
              stock: p.stock,
              price: p.price,
              from: p.priceFrom,
            },
          ];
    for (const item of entries) {
      const values = {
        product: item.name,
        spec: item.spec,
        stock: stockText(item.stock),
        price: money(item.price, currency) + (item.from ? ' 起' : ''),
        emoji: emoji(c, p.id),
      };
      const custom = override?.customEmojiId ?? c.appearance.customEmojiId;
      const makeText = (withEmoji: boolean) =>
        c.appearance.buttonTemplate
          .replace(/\{([a-z_]+)\}/g, (_, k: string) =>
            k === 'emoji' && !withEmoji ? '' : String(values[k as keyof typeof values] ?? ''),
          )
          .trim();
      rows.push([
        {
          text: clip(makeText(!custom)) || '查看商品',
          url: productURL(c, p),
          style: buttonStyle(override?.style ?? c.appearance.style, item.stock),
          ...(custom
            ? { icon_custom_emoji_id: custom, fallback_text: clip(makeText(true)) || '查看商品' }
            : {}),
        },
      ]);
    }
  }
  return rows;
}
function footerButtons(c: Config): Button[][] {
  const rows: Button[][] = [];
  const links = c.appearance.links.map((l) => ({
    text: l.customEmojiId ? l.text : `${l.emoji} ${l.text}`.trim(),
    url: l.url,
    style: l.style === 'auto' || l.style === 'default' ? undefined : l.style,
    ...(l.customEmojiId
      ? { icon_custom_emoji_id: l.customEmojiId, fallback_text: `${l.emoji} ${l.text}`.trim() }
      : {}),
  }));
  for (let i = 0; i < links.length; i += c.appearance.footerColumns)
    rows.push(links.slice(i, i + c.appearance.footerColumns));
  return rows;
}
function body(
  c: Config,
  kind: 'notification' | 'board',
  products: Product[],
  events: Change[],
  site: string,
  currency: string,
  at: number,
  page = 1,
  pages = 1,
): string {
  const f = c.appearance[kind],
    base = { site, time: formattedTime(at, f), page, pages };
  const productMap = new Map(products.map((p) => [p.id, p]));
  const details = events
    .map((e) => {
      const p = productMap.get(e.productId),
        delta =
          e.before.kind === 'exact' && e.after.kind === 'exact'
            ? e.after.quantity - e.before.quantity
            : null;
      const deltaString = delta === null ? '' : `${delta > 0 ? '+' : ''}${delta}`;
      const values = {
        ...base,
        product: c.products[e.productId]?.name || p?.name || e.productName,
        spec: e.skuName || '',
        spec_line: e.skuName ? `\n  ${escapeHTML(e.skuName)}` : '',
        price: p ? money(p.price, currency) : '',
        stock: stockText(e.after),
        before: e.type === 'price' ? money(e.beforePrice!, currency) : shortStock(e.before),
        after: e.type === 'price' ? money(e.afterPrice!, currency) : shortStock(e.after),
        delta: deltaString,
        delta_text: e.type === 'price' || !deltaString ? '' : `（${escapeHTML(deltaString)}）`,
        event: eventLabels[e.type],
        url: p ? productURL(c, p) : c.siteUrl,
        emoji: emoji(c, e.productId, true),
      };
      return template(f.changeTemplate, values, ['emoji', 'spec_line', 'delta_text']);
    })
    .join('\n\n');
  const sections = {
    header: template(f.header, base),
    top: template(f.top, base),
    details_title: template(f.detailsTitle, base),
    details,
    divider: template(f.divider, base),
    stock_title: template(f.stockTitle, base),
    footer: template(f.footer, base),
  };
  let text: string;
  if (f.bodyTemplate)
    text = template(f.bodyTemplate, { ...base, ...sections }, Object.keys(sections));
  else {
    const pieces: Record<string, string> = {
      header: sections.header,
      top: sections.top,
      details: details ? [sections.details_title, details].filter(Boolean).join('\n') : '',
      divider: sections.divider,
      stock: sections.stock_title,
      time: `更新于 ${escapeHTML(base.time)}${kind === 'board' ? ` · ${page}/${pages} 页` : ''}`,
      footer: sections.footer,
    };
    text = f.order
      .map((k) => pieces[k])
      .filter(Boolean)
      .join('\n\n');
  }
  if (!text.trim()) text = kind === 'board' ? '库存看板' : '库存变化';
  validateHTML(text);
  return text;
}
export function splitHTML(html: string, limit = 3200): string[] {
  const result: string[] = [],
    stack: { name: string; tag: string }[] = [];
  let current = '';
  const closing = () =>
    [...stack]
      .reverse()
      .map((x) => `</${x.name}>`)
      .join('');
  for (const token of html.match(/<[^>]*>|&(?:[a-z]+|#\d+|#x[\da-f]+);|[\s\S]/giu) ?? []) {
    if (current.length + token.length + closing().length + 32 > limit) {
      result.push(current + closing());
      current = stack.map((x) => x.tag).join('');
    }
    current += token;
    if (token.startsWith('</')) stack.pop();
    else if (token.startsWith('<'))
      stack.push({ name: /^<([a-z-]+)/.exec(token)![1]!, tag: token });
  }
  if (current) result.push(current);
  return result;
}
function payload(text: string, rows: Button[][]): MessagePayload {
  return {
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: rows },
  };
}
export function renderNotification(
  c: Config,
  products: Product[],
  events: Change[],
  site: string,
  currency: string,
  at: number,
): MessagePayload[] {
  const ids = new Set(events.map((e) => e.productId));
  const selected = sortedProducts(products, c).filter(
    (p) =>
      c.appearance.filter === 'all' ||
      (c.appearance.filter === 'available' ? isAvailable(p.stock) : ids.has(p.id)),
  );
  const rows = productButtons(selected, c, currency),
    texts = splitHTML(body(c, 'notification', products, events, site, currency, at));
  const count = Math.max(texts.length, Math.ceil(rows.length / 20), 1),
    out: MessagePayload[] = [];
  for (let i = 0; i < count; i++)
    out.push(
      payload(texts[i] ?? `库存列表（续 ${i + 1}/${count}）`, [
        ...rows.slice(i * 20, (i + 1) * 20),
        ...(i === count - 1 ? footerButtons(c) : []),
      ]),
    );
  return out;
}
export function renderBoard(
  c: Config,
  products: Product[],
  site: string,
  currency: string,
  at: number,
  page: number,
): { payload: MessagePayload; page: number; pages: number } {
  const selected = sortedProducts(products, c).filter(
    (p) => c.appearance.filter !== 'available' || isAvailable(p.stock),
  );
  // Pagination applies to button rows, so expanded SKUs cannot exceed the page budget.
  const rows = productButtons(selected, c, currency),
    pages = Math.max(1, Math.ceil(rows.length / c.timing.pageSize));
  page = Math.min(Math.max(page, 0), pages - 1);
  const text = body(c, 'board', products, [], site, currency, at, page + 1, pages);
  if (text.length > 3500) throw new Error('看板文本过长，请将渲染后的模板缩短至 3500 字符以内');
  const navigation: Button[] = [];
  if (page > 0)
    navigation.push({ text: '◀ 上一页', callback_data: `board:${page - 1}`, style: 'primary' });
  navigation.push({
    text: `🔄 ${page + 1}/${pages} 刷新`,
    callback_data: `board:${page}`,
    style: 'primary',
  });
  if (page < pages - 1)
    navigation.push({ text: '下一页 ▶', callback_data: `board:${page + 1}`, style: 'primary' });
  return {
    payload: payload(text, [
      ...rows.slice(page * c.timing.pageSize, (page + 1) * c.timing.pageSize),
      navigation,
      ...footerButtons(c),
    ]),
    page,
    pages,
  };
}
export function plainFallback(p: MessagePayload): MessagePayload {
  return {
    ...p,
    text: p.text.replace(/<tg-emoji emoji-id="\d+">([\s\S]*?)<\/tg-emoji>/g, '$1'),
    reply_markup: {
      inline_keyboard: p.reply_markup.inline_keyboard.map((r) =>
        r.map(({ icon_custom_emoji_id, fallback_text, ...b }) => ({
          ...b,
          text: fallback_text ?? b.text,
        })),
      ),
    },
  };
}
export function wirePayload(p: MessagePayload): MessagePayload {
  return {
    ...p,
    reply_markup: {
      inline_keyboard: p.reply_markup.inline_keyboard.map((r) =>
        r.map(({ fallback_text, ...b }) => b),
      ),
    },
  };
}
export function hasCustomEmoji(p: MessagePayload) {
  return (
    p.text.includes('<tg-emoji ') ||
    p.reply_markup.inline_keyboard.some((r) => r.some((b) => b.icon_custom_emoji_id))
  );
}
