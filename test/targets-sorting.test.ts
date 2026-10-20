import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTarget } from '../src/targets.js';
import { movedProductOrder, orderProducts } from '../src/sorting.js';
import { defaults } from '../src/config.js';
import { product } from './fixtures.js';

test('target normalization accepts usernames and IDs and rejects invite links and malformed targets', () => {
  assert.equal(normalizeTarget('  My_Channel  '), '@My_Channel');
  assert.equal(normalizeTarget('@My_Channel'), '@My_Channel');
  assert.equal(normalizeTarget('-1001234567890'), '-1001234567890');
  assert.equal(normalizeTarget('123456789'), '123456789');
  assert.equal(normalizeTarget('https://telegram.me/my_channel'), '@my_channel');
  for (const input of [
    '',
    '@',
    '频道名称',
    'my group',
    't.me/+abcdef',
    'https://t.me/my_channel/12',
    'https://evil.example/my_channel',
    '@@my_channel',
    't.me/my_channel?post=1',
  ])
    assert.throws(() => normalizeTarget(input));
});

test('product movement handles top, bottom, up, down, tied values and boundaries without mutating input', () => {
  const c = defaults(),
    products = [product(8, '3'), product(8, '1'), product(8, '2')];
  assert.deepEqual(
    orderProducts(products, c).map((p) => p.id),
    ['1', '2', '3'],
  );
  assert.deepEqual(movedProductOrder(products, c, '2', 'top'), ['2', '1', '3']);
  assert.deepEqual(movedProductOrder(products, c, '2', 'bottom'), ['1', '3', '2']);
  assert.deepEqual(movedProductOrder(products, c, '3', 'up'), ['1', '3', '2']);
  assert.deepEqual(movedProductOrder(products, c, '1', 'down'), ['2', '1', '3']);
  assert.equal(movedProductOrder(products, c, '1', 'up'), null);
  assert.equal(movedProductOrder(products, c, '3', 'bottom'), null);
  assert.deepEqual(
    products.map((p) => p.id),
    ['3', '1', '2'],
  );
  assert.deepEqual(c.products, {});
  assert.throws(() => movedProductOrder(products, c, '999', 'top'), /不可见/);
});
