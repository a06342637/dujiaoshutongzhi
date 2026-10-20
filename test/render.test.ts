import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, parseConfig } from '../src/config.js';
import {
  plainFallback,
  productButtons,
  renderBoard,
  renderNotification,
  renderPeriodicNotification,
  splitHTML,
  validateAppearance,
  validateHTML,
} from '../src/render.js';
import { product, stock } from './fixtures.js';
import type { Change } from '../src/types.js';
const event: Change = {
  productId: '1',
  productName: '商品',
  type: 'restock',
  before: stock(0),
  after: stock(8),
  at: 1,
};
test('defaults and templates validate; unsafe markup and unknown variables rejected', () => {
  const c = defaults();
  validateAppearance(c);
  c.appearance.notification.header = '<script>alert(1)</script>';
  assert.throws(() => validateAppearance(c));
  c.appearance.notification.header = '{unknown}';
  assert.throws(() => validateAppearance(c), /不支持变量/);
  c.appearance.notification.header = '<a href="javascript:alert(1)">X</a>';
  assert.throws(() => validateAppearance(c));
  assert.throws(() =>
    parseConfig({ ...defaults(), timing: { ...defaults().timing, interval: 0 } }),
  );
});
test('external product names escaped while admin formatting preserved', () => {
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  const p = product(8);
  p.name = 'A <b>&"';
  const result = renderNotification(c, [p], [event], '店铺 <x>', 'CNY', 1);
  assert.match(result[0]!.text, /A &lt;b&gt;&amp;&quot;/);
  assert.match(result[0]!.text, /<b>/);
  validateHTML(result[0]!.text);
  assert.equal(
    result[0]!.reply_markup.inline_keyboard[0]![0]!.url,
    'https://shop.example/products/product-1',
  );
});
test('long notifications split with valid HTML and retain all product links', () => {
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  const products = Array.from({ length: 65 }, (_, i) => product(8, String(i + 1)));
  c.appearance.notification.top = '<b>' + '长说明 '.repeat(180) + '</b>';
  const events = Array.from({ length: 70 }, (_, i) => ({
    ...event,
    productName: '长商品名'.repeat(30),
    skuName: '规格'.repeat(30),
    productId: String(i + 1),
  }));
  const messages = renderNotification(c, products, events, '店铺', 'CNY', 1);
  assert.ok(messages.length > 3);
  for (const m of messages) {
    assert.ok(m.text.length < 4096);
    validateHTML(m.text);
  }
  assert.equal(
    messages.flatMap((m) => m.reply_markup.inline_keyboard.flat()).filter((b) => b.url).length,
    65,
  );
  const chunks = splitHTML(
    '<b><i>' +
      '<&>'
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace(/&(?!lt|gt)/g, '&amp;')
        .repeat(1000) +
      '</i></b>',
  );
  chunks.forEach(validateHTML);
});
test('board pagination counts expanded SKU rows and clamps old pages', () => {
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  c.timing.pageSize = 5;
  c.products['1'] = { enabled: true, expandSkus: true };
  const p = product();
  p.skus = Array.from({ length: 12 }, (_, i) => ({
    id: String(i + 1),
    name: String(i + 1),
    price: '1',
    stock: stock(8),
  }));
  const board = renderBoard(c, [p], '店铺', 'CNY', 1, 99);
  assert.equal(board.pages, 3);
  assert.equal(board.page, 2);
  assert.equal(board.payload.reply_markup.inline_keyboard.filter((r) => r[0]?.url).length, 2);
});
test('per-product visual overrides, links, state colors and custom emoji fallback', () => {
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  c.products['1'] = {
    name: '别名',
    emoji: '🎮',
    customEmojiId: '123456',
    style: 'primary',
    url: 'https://shop.example/custom',
  };
  const buttons = productButtons([product()], c, 'USD');
  assert.match(buttons[0]![0]!.text, /别名/);
  assert.equal(buttons[0]![0]!.style, 'primary');
  assert.equal(buttons[0]![0]!.icon_custom_emoji_id, '123456');
  const message = renderNotification(c, [product()], [event], '店铺', 'USD', 1)[0]!;
  assert.match(message.text, /<tg-emoji/);
  const fallback = plainFallback(message);
  assert.ok(!fallback.text.includes('<tg-emoji'));
  assert.equal(fallback.reply_markup.inline_keyboard[0]![0]!.icon_custom_emoji_id, undefined);
});
test('board template overflow rejected and notifications preserve configurable currency', () => {
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  c.appearance.board.top = '字'.repeat(3000);
  c.appearance.board.footer = '尾'.repeat(1000);
  assert.throws(() => renderBoard(c, [product()], '店铺', 'USD', 1, 0), /过长/);
  assert.match(productButtons([product()], defaults(), 'USD')[0]![0]!.text, /US\$|\$/);
});
test('periodic notices include inventory even when the notification button filter is changed-only', () => {
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  c.appearance.filter = 'changed';
  c.appearance.notification.top = '欢迎选购';
  const result = renderPeriodicNotification(c, [product(5)], '店铺', 'CNY', Date.now());
  assert.ok(result[0]!.text.includes('定时库存通知'));
  assert.ok(result[0]!.text.includes('欢迎选购'));
  assert.ok(!result[0]!.text.includes('恢复有货'));
  assert.equal(result[0]!.reply_markup.inline_keyboard.flat().filter((b) => b.url).length, 1);
  assert.equal(c.appearance.filter, 'changed');
});
