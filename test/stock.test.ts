import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProduct, normalizeStock } from '../src/adapter.js';
import { advance, emptyEngine, mergeChanges } from '../src/engine.js';
import { defaults, isEnabled } from '../src/config.js';
import { rawProduct, product, stock } from './fixtures.js';

test('stock: exact, masked zero, range, infinite, unknown, contradictory data', () => {
  assert.deepEqual(normalizeStock({ auto_stock_available: 9 }, 'auto'), stock(9));
  assert.deepEqual(
    normalizeStock(
      { auto_stock_available: 0, stock_quantity_hidden: true, stock_status: 'in_stock' },
      'auto',
    ),
    { kind: 'hidden', status: 'in' },
  );
  assert.deepEqual(
    normalizeStock(
      {
        stock_display_mode: 'range',
        stock_display: 'range_6_20',
        stock_range_min: 6,
        stock_range_max: 20,
        stock_status: 'in_stock',
      },
      'auto',
    ),
    { kind: 'range', min: 6, max: 20, status: 'in' },
  );
  assert.deepEqual(normalizeStock({ manual_stock_available: -1 }, 'manual'), { kind: 'unlimited' });
  assert.deepEqual(normalizeStock({ auto_stock_available: -1 }, 'auto'), { kind: 'unlimited' });
  assert.deepEqual(normalizeStock({ manual_stock_available: null }, 'manual'), { kind: 'unknown' });
  assert.deepEqual(normalizeStock({ auto_stock_available: 0, stock_status: 'in_stock' }, 'auto'), {
    kind: 'unknown',
  });
  assert.deepEqual(normalizeStock({ stock_status: 'in_stock' }, 'auto'), { kind: 'unknown' });
});
test('stock: manual SKU total is available stock, not total minus sold; upstream and parent masks', () => {
  assert.deepEqual(
    normalizeStock({ manual_stock_total: 8, manual_stock_sold: 15 }, 'manual', true),
    stock(8),
  );
  assert.deepEqual(normalizeStock({ upstream_stock: 7 }, 'upstream', true), stock(7));
  assert.deepEqual(
    normalizeStock({ auto_stock_available: 0, stock_status: 'in_stock' }, 'auto', true, {
      stock_quantity_hidden: true,
    }),
    { kind: 'hidden', status: 'in' },
  );
});
test('normalizer keeps translated names and promotions and rejects invalid prices', () => {
  const raw = rawProduct(8);
  Object.assign(raw, { title: { 'zh-CN': '游戏 <A>' }, promotion_price_amount: '12.34' });
  Object.assign(raw.skus[0]!, {
    spec_values: { 'zh-CN': { 时长: '30天' }, 'en-US': { duration: '30days' } },
  });
  const p = normalizeProduct(raw);
  assert.equal(p.name, '游戏 <A>');
  assert.equal(p.price, '12.34');
  assert.equal(p.skus[0]!.name, '时长: 30天');
  assert.throws(() =>
    normalizeProduct({ ...raw, price_amount: null, promotion_price_amount: null }),
  );
});
test('first observation is a baseline; paused products are still baselined', () => {
  const c = defaults();
  let result = advance(emptyEngine(), [product(0)], c, 1);
  assert.equal(result.events.length, 0);
  result = advance(result.state, [product(8)], c, 2);
  assert.deepEqual(
    mergeChanges(result.events, c).map((e) => e.type),
    ['restock'],
  );
  c.products['1']!.enabled = false;
  result = advance(result.state, [product(3)], c, 3);
  assert.equal(result.events.length, 0);
  c.products['1']!.enabled = true;
  result = advance(result.state, [product(3)], c, 4);
  assert.equal(result.events.length, 0);
});
test('new-item auto monitoring does not toggle existing products', () => {
  const c = defaults();
  let r = advance(emptyEngine(), [product()], c, 1);
  c.autoMonitorNew = false;
  r = advance(r.state, [product(), product(8, '2')], c, 2);
  assert.equal(isEnabled(c, '1'), true);
  assert.equal(isEnabled(c, '2'), false);
  assert.equal(r.events.length, 0);
});
test('confirmation resets on reversion and works per product', () => {
  const c = defaults();
  c.timing.confirmations = 2;
  let r = advance(emptyEngine(), [product(5)], c, 1);
  r = advance(r.state, [product(4)], c, 2);
  assert.equal(r.events.length, 0);
  r = advance(r.state, [product(5)], c, 3);
  assert.equal(r.events.length, 0);
  r = advance(r.state, [product(4)], c, 4);
  assert.equal(r.events.length, 0);
  r = advance(r.state, [product(4)], c, 5);
  assert.ok(r.events.some((e) => e.type === 'decrease'));
});
test('missing new candidates do not count as consecutive confirmations', () => {
  const c = defaults();
  c.timing.confirmations = 2;
  let r = advance(emptyEngine(), [], c, 1);
  r = advance(r.state, [product()], c, 2);
  r = advance(r.state, [], c, 3);
  r = advance(r.state, [product()], c, 4);
  assert.equal(r.events.length, 0);
  assert.equal(Object.keys(r.state.accepted).length, 0);
});
test('product disappearance needs complete observations and is not sold-out', () => {
  const c = defaults();
  let r = advance(emptyEngine(), [product()], c, 1);
  r = advance(r.state, [], c, 2);
  assert.equal(r.events.length, 0);
  r = advance(r.state, [], c, 3);
  assert.deepEqual(
    r.events.map((e) => e.type),
    ['removed'],
  );
  assert.equal(mergeChanges(r.events, c).length, 0);
});
test('missing numeric field preserves comparator baseline', () => {
  const c = defaults();
  let r = advance(emptyEngine(), [product(8)], c, 1);
  const unknown = product(0);
  unknown.stock = { kind: 'unknown' };
  unknown.skus[0]!.stock = { kind: 'unknown' };
  r = advance(r.state, [unknown], c, 2);
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.state.accepted['1']!.stock, stock(8));
  r = advance(r.state, [product(7)], c, 3);
  assert.equal(r.events[0]!.type, 'decrease');
  assert.deepEqual(r.events[0]!.before, stock(8));
});
test('multi-SKU changes are noticed even when aggregate stays constant', () => {
  const c = defaults();
  const before = product(10);
  before.skus = [
    { id: '11', name: 'A', price: '10', stock: stock(5) },
    { id: '12', name: 'B', price: '20', stock: stock(5) },
  ];
  const after = structuredClone(before);
  after.skus[0]!.stock = stock(4);
  after.skus[1]!.stock = stock(6);
  let r = advance(emptyEngine(), [before], c, 1);
  r = advance(r.state, [after], c, 2);
  assert.deepEqual(
    r.events.map((e) => [e.skuName, e.type]),
    [
      ['A', 'decrease'],
      ['B', 'increase'],
    ],
  );
});
test('merge uses net delta and preserves sold-out and restock transitions', () => {
  const c = defaults();
  let r = advance(emptyEngine(), [product(5)], c, 1);
  const events = [];
  for (const [n, t] of [
    [4, 2],
    [3, 3],
    [0, 4],
    [5, 5],
  ]) {
    r = advance(r.state, [product(n)], c, t!);
    events.push(...r.events);
  }
  const merged = mergeChanges(events, c);
  assert.deepEqual(
    merged.map((e) => e.type),
    ['soldout', 'restock'],
  );
  c.timing.threshold = 3;
  r = advance(emptyEngine(), [product(10)], c, 1);
  const e = [];
  for (const [n, t] of [
    [9, 2],
    [8, 3],
    [7, 4],
  ]) {
    r = advance(r.state, [product(n)], c, t!);
    e.push(...r.events);
  }
  assert.equal(mergeChanges(e, c).length, 1);
  assert.deepEqual(mergeChanges(e, c)[0]!.before, stock(10));
});
test('range changes never invent a numeric delta; per-product event overrides apply', () => {
  const c = defaults();
  const p = product();
  p.stock = { kind: 'range', min: 1, max: 5, status: 'low' };
  let r = advance(emptyEngine(), [p], c, 1);
  p.stock = { kind: 'range', min: 6, max: 20, status: 'in' };
  r = advance(r.state, [p], c, 2);
  assert.equal(mergeChanges(r.events, c)[0]!.type, 'range');
  c.products['1']!.events = { range: false };
  assert.equal(mergeChanges(r.events, c).length, 0);
});
