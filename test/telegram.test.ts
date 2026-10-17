import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'grammy';
import { Store } from '../src/store.js';
import { TelegramTransport, DeliveryError, simpleMessage } from '../src/telegram.js';
import type { MessagePayload } from '../src/types.js';

test('Telegram custom emoji errors fall back once with ordinary icon and report to admin', async () => {
  const store = new Store(':memory:');
  const api = new Api('12345:test');
  const sent: any[] = [];
  api.config.use(async (_previous, _method, payload) => {
    sent.push(payload);
    if (sent.length === 1)
      return {
        ok: false,
        error_code: 400,
        description: 'Bad Request: CUSTOM_EMOJI_INVALID',
      } as any;
    return { ok: true, result: { message_id: 17 } } as any;
  });
  try {
    const transport = new TelegramTransport(api, store, '1');
    const message: MessagePayload = {
      ...simpleMessage('<tg-emoji emoji-id="123">🎮</tg-emoji> 库存'),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '商品 A',
              url: 'https://example.com',
              icon_custom_emoji_id: '123',
              fallback_text: '🎮 商品 A',
              style: 'success',
            },
          ],
        ],
      },
    };
    assert.equal(await transport.send('-1001', message), 17);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].reply_markup.inline_keyboard[0][0].fallback_text, undefined);
    assert.equal(sent[1].reply_markup.inline_keyboard[0][0].text, '🎮 商品 A');
    assert.equal(sent[1].reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, undefined);
    assert.equal(sent[1].text, '🎮 库存');
    assert.equal(store.jobs().length, 1);
    await transport.send('-1001', message);
    assert.equal(sent[2].reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, undefined);
  } finally {
    store.close();
  }
});
test('Telegram distinguishes rate limits, permission failures, and ambiguous 5xx responses', async () => {
  const store = new Store(':memory:');
  const api = new Api('12345:test');
  let code = 429;
  api.config.use(
    async () =>
      ({
        ok: false,
        error_code: code,
        description: 'test',
        parameters: code === 429 ? { retry_after: 42 } : {},
      }) as any,
  );
  try {
    const transport = new TelegramTransport(api, store, '1');
    await assert.rejects(
      transport.send('-1', simpleMessage('x')),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'rate' && e.retryAfter === 42000,
    );
    code = 403;
    await assert.rejects(
      transport.send('-1', simpleMessage('x')),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'permanent',
    );
    code = 500;
    await assert.rejects(
      transport.send('-1', simpleMessage('x')),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'uncertain',
    );
  } finally {
    store.close();
  }
});
