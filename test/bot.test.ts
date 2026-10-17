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
import { product } from './fixtures.js';
import { VERSION } from '../src/version.js';

function fixture() {
  const store = new Store(':memory:');
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  c.products['1'] = { enabled: true };
  store.saveConfig(c);
  store.set('catalog', [product()]);
  const calls: { method: string; payload: any }[] = [];
  const previews: MessagePayload[] = [];
  const transport = {
    send: async (_: string, p: MessagePayload) => {
      previews.push(p);
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
    let result: any = true;
    if (method === 'sendMessage' || method === 'editMessageText')
      result = {
        message_id: 10,
        date: 1,
        chat: { id: 1, type: 'private' },
        text: (payload as any).text,
      };
    if (method === 'getChat')
      result = { id: Number((payload as any).chat_id), type: 'channel', title: '测试频道' };
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
  return { store, service, bot, calls, previews, input, click };
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
