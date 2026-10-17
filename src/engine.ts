import { isEnabled, rules, type Config } from './config.js';
import type { Change, EngineState, Product, Stock } from './types.js';

export const emptyEngine = (): EngineState => ({
  initialized: false,
  accepted: {},
  candidates: {},
  missing: {},
});
export const stockKey = (s: Stock) => JSON.stringify(s);
export function isOut(s: Stock) {
  return (s.kind === 'exact' || s.kind === 'range' || s.kind === 'hidden') && s.status === 'out';
}
export function isAvailable(s: Stock) {
  return (
    s.kind === 'unlimited' ||
    ((s.kind === 'exact' || s.kind === 'range' || s.kind === 'hidden') &&
      (s.status === 'in' || s.status === 'low'))
  );
}
function fingerprint(p: Product) {
  return JSON.stringify([
    p.stock,
    p.price,
    p.skus
      .map((s) => [s.id, s.stock, s.price])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}
function retainKnown(p: Product, previous: Product | undefined): Product {
  if (!previous) return p;
  return {
    ...p,
    stock: p.stock.kind === 'unknown' ? previous.stock : p.stock,
    skus: p.skus.map((s) => {
      const old = previous.skus.find((x) => x.id === s.id);
      return s.stock.kind === 'unknown' && old ? { ...s, stock: old.stock } : s;
    }),
  };
}
export function stockChanges(before: Stock, after: Stock): Change['type'][] {
  if (before.kind === 'unknown' || after.kind === 'unknown' || stockKey(before) === stockKey(after))
    return [];
  const events: Change['type'][] = [];
  if (isOut(before) && isAvailable(after)) events.push('restock');
  if (isAvailable(before) && isOut(after)) events.push('soldout');
  if (before.kind === 'exact' && after.kind === 'exact') {
    if (after.quantity > before.quantity) events.push('increase');
    if (after.quantity < before.quantity) events.push('decrease');
  } else if (!events.length) events.push('range');
  return events;
}
function changes(previous: Product, next: Product, at: number): Change[] {
  const result: Change[] = [];
  const add = (
    before: Stock,
    after: Stock,
    oldPrice: string,
    newPrice: string,
    skuId?: string,
    skuName?: string,
  ) => {
    for (const type of stockChanges(before, after))
      result.push({
        productId: next.id,
        productName: next.name,
        skuId,
        skuName,
        type,
        before,
        after,
        at,
      });
    if (Number(oldPrice) !== Number(newPrice))
      result.push({
        productId: next.id,
        productName: next.name,
        skuId,
        skuName,
        type: 'price',
        before,
        after,
        beforePrice: oldPrice,
        afterPrice: newPrice,
        at,
      });
  };
  // Multi-SKU details are authoritative, avoiding duplicated aggregate deltas.
  if (next.skus.length > 1 || previous.skus.length > 1) {
    const oldMap = new Map(previous.skus.map((s) => [s.id, s]));
    for (const sku of next.skus) {
      const old = oldMap.get(sku.id);
      if (old) add(old.stock, sku.stock, old.price, sku.price, sku.id, sku.name);
      else
        result.push({
          productId: next.id,
          productName: next.name,
          skuId: sku.id,
          skuName: sku.name,
          type: 'added',
          before: { kind: 'unknown' },
          after: sku.stock,
          at,
        });
      oldMap.delete(sku.id);
    }
    for (const old of oldMap.values())
      result.push({
        productId: next.id,
        productName: next.name,
        skuId: old.id,
        skuName: old.name,
        type: 'removed',
        before: old.stock,
        after: { kind: 'unknown' },
        at,
      });
    // Some stores only expose reliable aggregate stock. Fall back when SKU data is unchanged.
    if (!result.some((e) => e.type !== 'price'))
      add(previous.stock, next.stock, previous.price, next.price);
  } else add(previous.stock, next.stock, previous.price, next.price);
  return result;
}
export function advance(
  state: EngineState,
  products: Product[],
  config: Config,
  at: number,
): { state: EngineState; events: Change[] } {
  const next: EngineState = structuredClone(state),
    events: Change[] = [];
  const seen = new Set(products.map((p) => p.id));
  for (const id of Object.keys(next.candidates)) if (!seen.has(id)) delete next.candidates[id];
  for (const raw of products) {
    const previous = next.accepted[raw.id];
    const p = retainKnown(structuredClone(raw), previous);
    delete next.missing[p.id];
    if (config.products[p.id]?.enabled === undefined)
      config.products[p.id] = { ...config.products[p.id], enabled: config.autoMonitorNew };
    if (!state.initialized) {
      next.accepted[p.id] = p;
      continue;
    }
    if (previous && fingerprint(previous) === fingerprint(p)) {
      next.accepted[p.id] = p;
      delete next.candidates[p.id];
      continue;
    }
    const signature = fingerprint(p);
    const candidate = next.candidates[p.id];
    const count = candidate?.signature === signature ? candidate.count + 1 : 1;
    next.candidates[p.id] = { signature, count };
    if (count < rules(config, p.id).confirmations) continue;
    if (isEnabled(config, p.id))
      events.push(
        ...(previous
          ? changes(previous, p, at)
          : [
              {
                productId: p.id,
                productName: p.name,
                type: 'added' as const,
                before: { kind: 'unknown' as const },
                after: p.stock,
                at,
              },
            ]),
      );
    next.accepted[p.id] = p;
    delete next.candidates[p.id];
  }
  for (const [id, previous] of Object.entries(next.accepted)) {
    if (seen.has(id)) continue;
    delete next.candidates[id];
    next.missing[id] = (next.missing[id] ?? 0) + 1;
    if (next.missing[id]! < config.timing.missingConfirmations) continue;
    if (isEnabled(config, id))
      events.push({
        productId: id,
        productName: previous.name,
        type: 'removed',
        before: previous.stock,
        after: { kind: 'unknown' },
        at,
      });
    delete next.accepted[id];
    delete next.missing[id];
  }
  next.initialized = true;
  return { state: next, events };
}
export function mergeChanges(events: Change[], config: Config): Change[] {
  const groups = new Map<string, Change[]>();
  for (const e of events) {
    if (!isEnabled(config, e.productId)) continue;
    const key = `${e.productId}:${e.skuId ?? ''}`;
    const g = groups.get(key) ?? [];
    g.push(e);
    groups.set(key, g);
  }
  const result: Change[] = [];
  for (const group of groups.values()) {
    const first = group[0]!,
      last = group.at(-1)!;
    const r = rules(config, first.productId);
    const transitions = group.filter(
      (e) =>
        ['restock', 'soldout', 'added', 'removed', 'range'].includes(e.type) && r.events[e.type],
    );
    // Preserve observed transitions, but collapse the duplicate delta attached to the same observation.
    const seen = new Set<string>();
    for (const e of transitions) {
      const key = `${e.type}:${e.at}:${stockKey(e.after)}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(e);
      }
    }
    if (first.before.kind === 'exact' && last.after.kind === 'exact') {
      const delta = last.after.quantity - first.before.quantity;
      const type = delta > 0 ? 'increase' : 'decrease';
      const sameTransition =
        transitions.length === 1 &&
        stockKey(transitions[0]!.before) === stockKey(first.before) &&
        stockKey(transitions[0]!.after) === stockKey(last.after);
      if (delta !== 0 && Math.abs(delta) >= r.threshold && r.events[type] && !sameTransition)
        result.push({ ...last, type, before: first.before, after: last.after });
    }
    const prices = group.filter((e) => e.type === 'price');
    if (
      prices.length &&
      r.events.price &&
      Number(prices[0]!.beforePrice) !== Number(prices.at(-1)!.afterPrice)
    )
      result.push({ ...prices.at(-1)!, beforePrice: prices[0]!.beforePrice });
  }
  return result.sort((a, b) => a.at - b.at);
}
