import type { Config } from './config.js';
import type { Product } from './types.js';

export const moveDirections = ['up', 'down', 'top', 'bottom'] as const;
export type MoveDirection = (typeof moveDirections)[number];

export function orderProducts(products: Product[], config: Config): Product[] {
  return [...products].sort(
    (a, b) =>
      (config.products[a.id]?.order ?? 0) - (config.products[b.id]?.order ?? 0) ||
      a.name.localeCompare(b.name, 'zh-CN') ||
      a.id.localeCompare(b.id),
  );
}

export function movedProductOrder(
  products: Product[],
  config: Config,
  id: string,
  direction: MoveDirection,
): string[] | null {
  const ids = orderProducts(products, config).map((p) => p.id),
    from = ids.indexOf(id);
  if (from < 0) throw new Error('商品已不可见，请刷新商品列表。');
  const to =
    direction === 'top'
      ? 0
      : direction === 'bottom'
        ? ids.length - 1
        : Math.max(0, Math.min(ids.length - 1, from + (direction === 'up' ? -1 : 1)));
  if (from === to) return null;
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return ids;
}
