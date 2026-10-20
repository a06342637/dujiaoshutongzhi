import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryCopyText, INVENTORY_COPY_FOOTER } from '../src/inventory-copy.js';
import { normalizeProduct } from '../src/adapter.js';
import { defaults } from '../src/config.js';
import { product, rawProduct } from './fixtures.js';

test('copy lists in-stock products including manual fulfillment, respects order and adds the exact footer', () => {
  const c = defaults();
  c.products['2'] = { name: '手动发货商品', order: -10, enabled: false };
  const manual = normalizeProduct({
    ...rawProduct(5, 2),
    fulfillment_type: 'manual',
    manual_stock_available: 7,
    skus: [
      {
        id: 21,
        is_active: true,
        price_amount: '12.50',
        manual_stock_total: 7,
        manual_stock_sold: 20,
        spec_values: {},
      },
    ],
    price_amount: '12.50',
  });
  const text = inventoryCopyText([product(0, '3'), product(5, '1'), manual], c, 'CNY')!;
  assert.ok(text.startsWith('手动发货商品'));
  assert.match(text, /12\.50.*库存：7/);
  assert.ok(!text.includes('商品 3'));
  assert.ok(text.endsWith(INVENTORY_COPY_FOOTER));
  assert.equal(text.split(INVENTORY_COPY_FOOTER).length, 2);
});
test('copy handles unlimited, hidden and range stocks without inventing quantities', () => {
  const infinite = product(8, '1');
  infinite.stock = { kind: 'unlimited' };
  const hidden = product(8, '2');
  hidden.stock = { kind: 'hidden', status: 'in' };
  const range = product(8, '3');
  range.stock = { kind: 'range', min: 6, max: 20, status: 'in' };
  const unknown = product(8, '4');
  unknown.stock = { kind: 'unknown' };
  const text = inventoryCopyText([infinite, hidden, range, unknown], defaults(), 'USD')!;
  assert.match(text, /库存：无限/);
  assert.match(text, /数量未公开/);
  assert.match(text, /6～20/);
  assert.ok(!text.includes('商品 4'));
  assert.match(text, /US\$|\$/);
  assert.equal(inventoryCopyText([product(0)], defaults(), 'CNY'), null);
});
