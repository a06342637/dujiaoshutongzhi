import { Api, GrammyError, HttpError } from 'grammy';
import type { MessagePayload } from './types.js';
import { hasCustomEmoji, plainFallback, wirePayload } from './render.js';
import type { Store } from './store.js';

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate' | 'retry' | 'permanent' | 'uncertain',
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}
export interface Transport {
  send(target: string, payload: MessagePayload): Promise<number>;
  edit(target: string, id: number, payload: MessagePayload): Promise<void>;
}
export const simpleMessage = (text: string): MessagePayload => ({
  text,
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
  reply_markup: { inline_keyboard: [] },
});
export class TelegramTransport implements Transport {
  constructor(
    private api: Api,
    private store: Store,
    private adminId: string,
  ) {}
  private async perform(
    target: string,
    p: MessagePayload,
    fn: (p: MessagePayload) => Promise<unknown>,
  ): Promise<unknown> {
    if (this.store.get(`emoji-disabled:${target}`, false)) p = plainFallback(p);
    try {
      return await fn(p);
    } catch (e) {
      if (e instanceof GrammyError) {
        if (e.error_code === 400 && /message is not modified/i.test(e.description)) return true;
        if (
          e.error_code === 400 &&
          hasCustomEmoji(p) &&
          /emoji|premium|fragment/i.test(e.description)
        ) {
          this.store.set(`emoji-disabled:${target}`, true);
          this.store.enqueue(
            `emoji-fallback:${target}`,
            this.adminId,
            simpleMessage(
              `目标 ${target} 不支持当前自定义表情，已回退普通 emoji。可在通知目标中重新测试。`,
            ),
          );
          return this.perform(target, plainFallback(p), fn);
        }
        if (e.error_code === 429)
          throw new DeliveryError('Telegram 限流', 'rate', (e.parameters.retry_after ?? 30) * 1000);
        // HTTP 5xx can occur after a message was accepted. Treat send outcomes conservatively.
        if (e.error_code >= 500)
          throw new DeliveryError(`Telegram 服务异常 ${e.error_code}`, 'uncertain');
        throw new DeliveryError(e.description, 'permanent');
      }
      if (e instanceof HttpError)
        throw new DeliveryError('Telegram 网络异常，发送结果无法确认', 'uncertain');
      throw new DeliveryError('Telegram 请求异常，结果无法确认', 'uncertain');
    }
  }
  async send(target: string, p: MessagePayload): Promise<number> {
    const result = await this.perform(target, p, (v) =>
      this.api.raw.sendMessage({ chat_id: target, ...wirePayload(v) }),
    );
    if (!result || typeof result !== 'object' || !('message_id' in result))
      throw new DeliveryError('Telegram 未返回消息 ID', 'uncertain');
    return Number(result.message_id);
  }
  async edit(target: string, id: number, p: MessagePayload): Promise<void> {
    await this.perform(target, p, (v) =>
      this.api.raw.editMessageText({ chat_id: target, message_id: id, ...wirePayload(v) }),
    );
  }
}
