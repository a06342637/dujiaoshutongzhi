import { isEnabled, showsStock, type Config } from './config.js';
import type { Product, Stock } from './types.js';
import { isAvailable } from './engine.js';
import { orderProducts } from './sorting.js';
import { money, stockText } from './render.js';

export const INVENTORY_COPY_FOOTER = '购买点击头像 资料网站';
function quantity(stock: Stock) {
  if (stock.kind === 'exact') return String(stock.quantity);
  if (stock.kind === 'hidden')
    return stock.status === 'low' ? '库存紧张（数量未公开）' : '有货（数量未公开）';
  return stockText(stock);
}
export function inventoryCopyText(
  products: Product[],
  config: Config,
  currency: string,
): string | null {
  const available = orderProducts(products, config).filter(
    (p) => isEnabled(config, p.id) && isAvailable(p.stock),
  );
  if (!available.length) return null;
  const lines = available.map((p) => {
    const name = (config.products[p.id]?.name || p.name).replace(/\s+/gu, ' ').trim();
    return `${name} | ${money(p.price, currency)}${p.priceFrom ? ' 起' : ''}${showsStock(config, p.id) ? ` | 库存：${quantity(p.stock)}` : ''}`;
  });
  return `${lines.join('\n')}\n\n${INVENTORY_COPY_FOOTER}`;
}
