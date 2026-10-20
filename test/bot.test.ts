import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { AdminBot, canManage } from '../src/bot.js';
import { Store } from '../src/store.js';
import { StockService } from '../src/service.js';
import { DujiaoAdapter } from '../src/adapter.js';
import type { MessagePayload } from '../src/types.js';
import { defaults } from '../src/config.js';
import { product, scan } from './fixtures.js';
import { VERSION } from '../src/version.js';
import { INVENTORY_COPY_FOOTER } from '../src/inventory-copy.js';
import { sortedProducts, renderBoard, renderNotification } from '../src/render.js';
import { inventoryCopyText } from '../src/inventory-copy.js';

function fixture(apiReply?: (method: string, payload: any) => any) {
  const store = new Store(':memory:');
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  c.products['1'] = { enabled: true };
  store.saveConfig(c);
  store.set('catalog', [product()]);
  const calls: { method: string; payload: any }[] = [];
  const previews: MessagePayload[] = [];
  const sent: { target: string; payload: MessagePayload }[] = [];
  const transport = {
    send: async (target: string, p: MessagePayload) => {
      previews.push(p);
      sent.push({ target, payload: p });
      return 1;
    },
    edit: async () => {},
  };
  const service = new StockService(store, new DujiaoAdapter(), transport, '1');
  const bot = new Bot('12345:test', {
    botInfo: {
      id: 12345,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const custom = apiReply?.(method, payload);
    if (custom !== undefined) return custom;
    let result: any = true;
    if (method === 'sendMessage' || method === 'editMessageText')
      result = {
        message_id: 10,
        date: 1,
        chat: { id: 1, type: 'private' },
        text: (payload as any).text,
      };
    if (method === 'getChat') {
      const supplied = String((payload as any).chat_id),
        id = supplied.startsWith('@') ? -1001 : Number(supplied);
      result =
        id > 0
          ? { id, type: 'private', first_name: 'Admin' }
          : { id, type: 'channel', title: '测试频道' };
    }
    if (method === 'getChatMember') result = { status: 'administrator', can_post_messages: true };
    return { ok: true, result } as any;
  });
  new AdminBot(bot, service);
  let seq = 1;
  const input = async (text: string, user = 1, chatType = 'private') => {
    const update = {
      update_id: seq++,
      message: {
        message_id: seq,
        date: 1,
        from: { id: user, is_bot: false, first_name: 'Admin' },
        chat: { id: user, type: chatType },
        text,
        ...(text.startsWith('/')
          ? { entities: [{ offset: 0, length: text.length, type: 'bot_command' }] }
          : {}),
      },
    } as Update;
    await bot.handleUpdate(update);
  };
  const click = async (data: string, user = 1) => {
    const update = {
      update_id: seq++,
      callback_query: {
        id: String(seq),
        from: { id: user, is_bot: false, first_name: 'Admin' },
        chat_instance: 'x',
        data,
        message: { message_id: 10, date: 1, chat: { id: user, type: 'private' }, text: 'menu' },
      },
    } as Update;
    await bot.handleUpdate(update);
  };
  return { store, service, bot, calls, previews, sent, input, click };
}
test('administrator isolation for private settings', async () => {
  assert.equal(canManage(1, 'private', '1'), true);
  assert.equal(canManage(2, 'private', '1'), false);
  assert.equal(canManage(1, 'group', '1'), false);
  const f = fixture();
  try {
    await f.input('/start', 2);
    assert.equal(f.calls.length, 0);
    await f.click('toggle:paused', 2);
    assert.equal(f.store.config().paused, false);
    await f.input('/start');
    assert.ok(f.calls.some((c) => String(c.payload.text).includes('独角数卡')));
  } finally {
    f.store.close();
  }
});
test('version is visible in home and settings', async () => {
  const f = fixture();
  try {
    await f.input('/start');
    await f.input('/version');
    assert.ok(f.calls.filter((c) => String(c.payload.text).includes(`v${VERSION}`)).length >= 2);
    assert.ok(f.calls.some((c) => JSON.stringify(c.payload.reply_markup).includes('update:check')));
  } finally {
    f.store.close();
  }
});
test('numeric menus validate, retry input, default and cancel without restart', async () => {
  const f = fixture();
  try {
    await f.click('number:interval');
    await f.input('0');
    assert.equal(f.store.config().timing.interval, 15);
    assert.ok(f.store.get('pending', null));
    await f.input('2');
    assert.equal(f.store.config().timing.interval, 2);
    await f.click('number:interval');
    await f.input('default');
    assert.equal(f.store.config().timing.interval, 15);
    await f.click('number:timeout');
    await f.input('/cancel');
    assert.equal(f.store.get('pending', null), null);
  } finally {
    f.store.close();
  }
});
test('periodic toggle and numeric interval are available in monitoring settings', async () => {
  const f = fixture();
  try {
    await f.click('timing');
    assert.ok(
      JSON.stringify(f.calls.at(-1)!.payload.reply_markup).includes(
        'toggle:periodicNotifications:timing',
      ),
    );
    await f.click('number:periodicInterval');
    await f.input('600');
    assert.equal(f.store.config().timing.periodicInterval, 600);
    assert.equal(f.store.config().periodicNotifications, false);
    await f.click('toggle:periodicNotifications:timing');
    assert.equal(f.store.config().periodicNotifications, true);
    await f.click('number:periodicInterval');
    await f.input('30');
    assert.equal(f.store.config().timing.periodicInterval, 600);
    assert.ok(f.store.get('pending', null));
    await f.input('/cancel');
    await f.click('toggle:notifications');
    assert.equal(f.store.config().notifications, false);
    assert.equal(f.store.config().periodicNotifications, true);
  } finally {
    f.store.close();
  }
});
test('home copy inventory refreshes data and sends clipboard text with exact footer to the admin only', async () => {
  const f = fixture();
  try {
    const c = f.store.config();
    c.paused = true;
    f.store.saveConfig(c);
    f.service.adapter.scan = async () => scan([product(7), product(0, '2')]);
    await f.input('/start');
    assert.ok(JSON.stringify(f.calls.at(-1)!.payload.reply_markup).includes('copy-stock'));
    await f.click('copy-stock', 2);
    assert.ok(!f.calls.some((c) => c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.copy_text));
    await f.click('copy-stock');
    const copied = f.calls.find((c) => c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.copy_text)
      ?.payload.reply_markup.inline_keyboard[0][0].copy_text.text;
    assert.ok(copied.includes('库存：7'));
    assert.ok(!copied.includes('商品 2'));
    assert.ok(copied.endsWith(INVENTORY_COPY_FOOTER));
    assert.equal(f.store.config().paused, true);
  } finally {
    f.store.close();
  }
});
test('per-product stock visibility saves as a draft and does not change monitoring', async () => {
  const f = fixture();
  try {
    await f.click('pstock:1');
    assert.equal(f.store.config().products['1']!.showStock, undefined);
    await f.click('draft:save');
    const c = f.store.config();
    assert.equal(c.products['1']!.showStock, false);
    assert.equal(c.products['1']!.enabled, true);
    const text = inventoryCopyText([product(983)], c, 'CNY')!;
    assert.ok(!text.includes('983'));
    assert.ok(text.includes('商品 1'));
    await f.click('pinherit:1');
    await f.click('draft:save');
    assert.ok(inventoryCopyText([product(983)], f.store.config(), 'CNY')!.includes('983'));
  } finally {
    f.store.close();
  }
});
test('logs menu prints the last 50 lines, escapes HTML and blocks non-admin access', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 70; i++) f.service.logs.info(`row-${String(i).padStart(3, '0')} <event>`);
    await f.click('logs', 2);
    assert.ok(!f.calls.some((c) => String(c.payload.text).includes('row-')));
    await f.click('logs');
    let text = String(f.calls.at(-1)!.payload.text);
    assert.ok(text.includes('最近 50 行'));
    assert.ok(text.includes('row-020'));
    assert.ok(!text.includes('row-019'));
    assert.ok(text.includes('&lt;event&gt;'));
    await f.click('logs:page:1');
    text = String(f.calls.at(-1)!.payload.text);
    assert.ok(text.length < 4096);
    f.service.logs.info('newest');
    await f.click('logs');
    await f.click('logs:page:999');
    assert.ok(String(f.calls.at(-1)!.payload.text).includes('newest'));
  } finally {
    f.store.close();
  }
});
test('empty logs menu is usable before the first runtime event', async () => {
  const f = fixture();
  try {
    await f.input('/logs');
    assert.ok(String(f.calls.at(-1)!.payload.text).includes('暂无应用日志'));
  } finally {
    f.store.close();
  }
});
test('large inventory copy uses safe code blocks without exceeding Telegram clipboard limits', async () => {
  const f = fixture();
  try {
    f.service.adapter.scan = async () =>
      scan(
        Array.from({ length: 10 }, (_, i) => ({
          ...product(9, String(i + 1)),
          name: `商品 <${i}> ` + '长名称'.repeat(12),
        })),
      );
    await f.click('copy-stock');
    const content = f.calls.filter(
      (c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('<pre>'),
    );
    assert.ok(content.length > 0);
    assert.ok(content[0]!.payload.text.includes('&lt;0&gt;'));
    for (const call of content) {
      assert.ok(call.payload.text.length < 4096);
      assert.ok(!call.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.copy_text);
    }
  } finally {
    f.store.close();
  }
});
test('very long inventory copy includes a complete text attachment', async () => {
  const f = fixture();
  try {
    f.service.adapter.scan = async () =>
      scan(
        Array.from({ length: 70 }, (_, i) => ({
          ...product(9, String(i + 1)),
          name: `商品 ${i} ` + '完整名称'.repeat(20),
        })),
      );
    await f.click('copy-stock');
    assert.ok(
      f.calls.filter(
        (c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('<pre>'),
      ).length > 1,
    );
    assert.ok(
      f.calls.some(
        (c) => c.method === 'sendDocument' && String(c.payload.caption).includes('完整库存文案'),
      ),
    );
  } finally {
    f.store.close();
  }
});
test('visual editing is a draft until preview and save; monitored state survives draft', async () => {
  const f = fixture();
  try {
    await f.click('pinput:1:name');
    await f.input('新名称');
    assert.equal(f.store.config().products['1']!.name, undefined);
    await f.click('product-toggle:1');
    assert.equal(f.store.config().products['1']!.enabled, false);
    await f.click('preview:notification');
    assert.ok(f.previews.length > 0);
    await f.click('draft:save');
    assert.equal(f.store.config().products['1']!.name, '新名称');
    assert.equal(f.store.config().products['1']!.enabled, false);
    await f.click('pinput:1:emoji');
    await f.input('🎮');
    await f.click('draft:discard');
    assert.equal(f.store.config().products['1']!.emoji, undefined);
  } finally {
    f.store.close();
  }
});
test('templates reject unsafe content, support sections and standalone variable help', async () => {
  const f = fixture();
  try {
    await f.click('finput:notification:header');
    await f.input('<script>bad</script>');
    assert.equal(
      f.store.config().appearance.notification.header,
      defaults().appearance.notification.header,
    );
    await f.input('<b>{site}</b> 新通知');
    await f.click('draft:save');
    assert.equal(f.store.config().appearance.notification.header, '<b>{site}</b> 新通知');
    await f.click('variables');
    assert.ok(f.calls.some((c) => String(c.payload.text).includes('{details}')));
  } finally {
    f.store.close();
  }
});
test('product search, category filters and bulk enable/disable', async () => {
  const f = fixture();
  try {
    f.store.set('catalog', [product(3, '1'), product(5, '2')]);
    await f.click('input:search');
    await f.input('商品 1');
    await f.click('bulk:off');
    assert.equal(f.store.config().products['1']!.enabled, false);
    assert.equal(f.store.config().products['2'], undefined);
    await f.click('filter:clear');
    await f.click('bulk:on');
    assert.equal(f.store.config().products['2']!.enabled, true);
  } finally {
    f.store.close();
  }
});
test('JSON import requires confirmation and clears old runtime baseline', async () => {
  const f = fixture();
  try {
    const imported = defaults();
    imported.siteUrl = 'https://another.example';
    imported.timing.interval = 7;
    await f.click('input:import');
    await f.input(JSON.stringify(imported));
    assert.equal(f.store.config().siteUrl, 'https://shop.example');
    await f.click('confirm:import');
    assert.equal(f.store.config().siteUrl, 'https://shop.example');
    await f.click('do:import');
    assert.equal(f.store.config().timing.interval, 7);
    assert.equal(f.store.get('catalog', null), null);
  } finally {
    f.store.close();
  }
});
test('all main menus render with callback payloads under Telegram byte limits', async () => {
  const f = fixture();
  try {
    for (const path of [
      'home',
      'site',
      'timing',
      'rules',
      'products:0',
      'sort:0',
      'categories',
      'product:1',
      'prules:1',
      'templates',
      'format:notification',
      'format:board',
      'buttons',
      'links',
      'targets',
      'boards',
      'status',
      'failures',
      'backup',
    ])
      await f.click(path);
    for (const call of f.calls)
      for (const row of call.payload.reply_markup?.inline_keyboard ?? [])
        for (const b of row)
          if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    assert.ok(
      !f.calls.some(
        (c) => c.method === 'sendMessage' && String(c.payload.text).includes('菜单已过期'),
      ),
    );
  } finally {
    f.store.close();
  }
});

test('target binding accepts bare usernames, @names and public links and stores numeric ID', async () => {
  for (const text of ['my_shop', '@my_shop', 'https://t.me/my_shop', 't.me/my_shop/']) {
    const f = fixture();
    try {
      await f.click('input:target');
      await f.input(text);
      assert.equal(f.calls.find((c) => c.method === 'getChat')!.payload.chat_id, '@my_shop');
      assert.deepEqual(f.store.config().targets, [
        { id: '-1001', title: '测试频道', enabled: true },
      ]);
      assert.equal(f.store.get('pending', null), null);
      assert.ok(f.calls.some((c) => String(c.payload.text).includes('已绑定并启用')));
    } finally {
      f.store.close();
    }
  }
});

test('legacy target picker bypasses the Telegram USER_RIGHTS_MISSING keyboard error', async () => {
  const f = fixture((_method, payload) =>
    payload.reply_markup?.keyboard
      ? { ok: false, error_code: 400, description: 'Bad Request: USER_RIGHTS_MISSING' }
      : undefined,
  );
  try {
    await f.click('target-picker');
    assert.equal(f.store.get<{ kind: string } | null>('pending', null)?.kind, 'target');
    assert.ok(f.calls.some((c) => c.payload.reply_markup?.remove_keyboard === true));
    assert.ok(!f.calls.some((c) => c.payload.reply_markup?.keyboard));
    await f.input('my_shop');
    assert.equal(f.store.config().targets.length, 1);
  } finally {
    f.store.close();
  }
});

test('public group username binds when the bot is an administrator', async () => {
  const f = fixture((method) =>
    method === 'getChat'
      ? { ok: true, result: { id: -1002, type: 'supergroup', title: '测试群' } }
      : undefined,
  );
  try {
    await f.click('input:target');
    await f.input('my_group');
    assert.equal(f.store.config().targets[0]?.id, '-1002');
    assert.equal(f.store.config().targets[0]?.title, '测试群');
  } finally {
    f.store.close();
  }
});

test('binding rejects missing membership, group admin rights and channel publishing rights', async () => {
  for (const item of [
    { type: 'supergroup', member: { status: 'member' }, message: '管理员' },
    {
      type: 'channel',
      member: { status: 'administrator', can_post_messages: false },
      message: '发布消息',
    },
    { type: 'channel', member: { status: 'left' }, message: '尚未加入' },
    { type: 'channel', member: { status: 'kicked' }, message: '尚未加入' },
  ]) {
    const f = fixture((method) =>
      method === 'getChat'
        ? { ok: true, result: { id: -1001, type: item.type, title: '测试' } }
        : method === 'getChatMember'
          ? { ok: true, result: item.member }
          : undefined,
    );
    try {
      await f.click('input:target');
      await f.input('my_shop');
      assert.equal(f.store.config().targets.length, 0);
      assert.ok(f.store.get('pending', null));
      assert.ok(
        f.calls.some(
          (c) => c.method === 'sendMessage' && String(c.payload.text).includes(item.message),
        ),
      );
    } finally {
      f.store.close();
    }
  }
});

test('binding failure is actionable and can be retried without losing input state', async () => {
  let failed = true;
  const f = fixture((method) =>
    failed && method === 'getChat'
      ? { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
      : undefined,
  );
  try {
    await f.click('input:target');
    await f.input('my_shop');
    assert.equal(f.store.config().targets.length, 0);
    assert.ok(f.calls.some((c) => String(c.payload.text).includes('找不到该频道／群')));
    failed = false;
    await f.input('my_shop');
    assert.equal(f.store.config().targets.length, 1);
  } finally {
    f.store.close();
  }
});

test('rebind deduplicates and re-enables the target without changing global pause preferences', async () => {
  const f = fixture();
  try {
    await f.click('input:target');
    await f.input('my_shop');
    const c = f.store.config();
    c.targets[0]!.enabled = false;
    c.paused = true;
    f.store.saveConfig(c);
    await f.click('input:target');
    await f.input('@my_shop');
    assert.equal(f.store.config().targets.length, 1);
    assert.equal(f.store.config().targets[0]!.enabled, true);
    assert.equal(f.store.config().paused, true);
    assert.ok(f.calls.some((c) => String(c.payload.text).includes('当前全局监测已暂停')));
  } finally {
    f.store.close();
  }
});

test('binding a username routes subsequent inventory notifications to its stable chat ID', async () => {
  const f = fixture();
  try {
    const c = f.store.config();
    c.timing.mergeWindow = 0;
    f.store.saveConfig(c);
    f.service.adapter.scan = async () => scan([product(8)]);
    await f.service.check();
    await f.click('input:target');
    await f.input('my_shop');
    f.service.adapter.scan = async () => scan([product(7)]);
    await f.service.check();
    await f.service.sendDue();
    assert.ok(f.sent.some((m) => m.target === '-1001' && m.payload.text.includes('可售减少')));
  } finally {
    f.store.close();
  }
});

test('product movement updates draft manager order and saved notification order including paused items', async () => {
  const f = fixture();
  const menuProductIds = () =>
    f.calls
      .at(-1)!
      .payload.reply_markup.inline_keyboard.flat()
      .filter((b: any) => b.callback_data?.startsWith('product:'))
      .map((b: any) => b.callback_data.slice(8));
  try {
    const products = [product(3, '1'), product(3, '2'), product(3, '3')];
    f.store.set('catalog', products);
    const c = f.store.config();
    c.products['2'] = { enabled: false, emoji: '🧩' };
    f.store.saveConfig(c);
    await f.click('pinput:3:name');
    await f.input('第三件');
    await f.click('pmove:3:top');
    await f.click('products:0');
    assert.deepEqual(menuProductIds(), ['3', '1', '2']);
    assert.equal(f.store.config().products['3']?.order, undefined);
    await f.click('draft:save');
    assert.deepEqual(
      sortedProducts(products, f.store.config()).map((p) => p.id),
      ['3', '1'],
    );
    const config = f.store.config();
    const board = renderBoard(config, products, '测试', 'CNY', Date.now(), 0).payload;
    const notification = renderNotification(config, products, [], '测试', 'CNY', Date.now())[0]!;
    for (const message of [board, notification])
      assert.deepEqual(
        message.reply_markup.inline_keyboard
          .flat()
          .filter((b) => b.url)
          .map((b) => b.url!.split('product-')[1]),
        ['3', '1'],
      );
    assert.equal(f.store.config().products['3']!.name, '第三件');
    assert.equal(f.store.config().products['2']!.enabled, false);
    assert.equal(f.store.config().products['2']!.emoji, '🧩');
    await f.click('pmove:3:down');
    await f.click('sort:0');
    assert.deepEqual(menuProductIds(), ['1', '3', '2']);
    await f.click('draft:discard');
    await f.click('sort:0');
    assert.deepEqual(menuProductIds(), ['3', '1', '2']);
  } finally {
    f.store.close();
  }
});

test('manual sort number changes are visible in management and remain a draft until saved', async () => {
  const f = fixture();
  try {
    f.store.set('catalog', [product(8, '1'), product(8, '2')]);
    await f.click('pinput:2:order');
    await f.input('-2');
    await f.click('products:0');
    const first = f.calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0];
    assert.equal(first.callback_data, 'product:2');
    await f.click('draft:save');
    assert.equal(f.store.config().products['2']!.order, -2);
    await f.click('pinput:2:order');
    await f.input('wrong');
    assert.equal(f.store.config().products['2']!.order, -2);
    assert.ok(f.store.get('pending', null));
  } finally {
    f.store.close();
  }
});
