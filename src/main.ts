import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Bot } from 'grammy';
import { Store } from './store.js';
import { DujiaoAdapter } from './adapter.js';
import { TelegramTransport } from './telegram.js';
import { StockService } from './service.js';
import { AdminBot } from './bot.js';
import { validateAppearance } from './render.js';
import { UpdateManager } from './updater.js';
import { VERSION } from './version.js';

const token = process.env.BOT_TOKEN?.trim(),
  admin = process.env.ADMIN_USER_ID?.trim();
if (!token || !/^\d+:[\w-]+$/.test(token) || !admin || !/^\d{1,20}$/.test(admin)) {
  console.error('请设置有效的 BOT_TOKEN 和 ADMIN_USER_ID 两个启动参数。');
  process.exit(1);
}
const data = resolve(process.env.DATA_DIR || 'data');
mkdirSync(data, { recursive: true });
const store = new Store(resolve(data, 'bot.sqlite'));
validateAppearance(store.config());
const bot = new Bot(token, { client: { timeoutSeconds: 35 } });
const service = new StockService(
  store,
  new DujiaoAdapter(),
  new TelegramTransport(bot.api, store, admin),
  admin,
);
const updates = new UpdateManager(data);
new AdminBot(bot, service, updates);
bot.catch(() => console.error('Telegram 更新处理失败，请在 Bot 中重试。'));
let stopping = false;
const heartbeat = setInterval(
  () => writeFileSync(resolve(data, 'heartbeat'), String(Date.now())),
  10000,
);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  if (bot.isRunning()) await bot.stop();
  await service.stop();
  store.close();
  if (process.connected) process.disconnect();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
    void shutdown().then(() => process.exit(0));
});
try {
  await bot.init();
  const webhook = await bot.api.getWebhookInfo();
  if (webhook.url)
    throw new Error('此 Bot 已配置 Webhook，请使用专用 Bot 或先在 Telegram 管理端移除旧 Webhook。');
  await bot.api.setMyCommands([
    { command: 'start', description: '打开管理菜单' },
    { command: 'menu', description: '中文管理菜单' },
    { command: 'cancel', description: '取消当前输入' },
    { command: 'help', description: '使用说明' },
    { command: 'version', description: '当前版本与程序更新' },
    { command: 'settings', description: '设置与一键更新' },
  ]);
  if (process.send && process.env.DUJIAO_SUPERVISED === '1') {
    // Probe polling without advancing the offset before declaring the candidate healthy.
    await bot.api.getUpdates({ limit: 1, timeout: 0 });
    await new Promise<void>((resolve) => {
      const listener = (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'activate'
        ) {
          process.off('message', listener);
          resolve();
        }
      };
      process.on('message', listener);
      process.send!({ type: 'ready', version: VERSION });
    });
  }
  writeFileSync(resolve(data, 'heartbeat'), String(Date.now()));
  const result = updates.status();
  if (result && store.get('last-update-report', '') !== result.id) {
    service.report(result.message, `update-${result.id}`);
    store.set('last-update-report', result.id);
  }
  service.start();
  console.log(`库存通知 Bot v${VERSION} 已启动，请由管理员私聊发送 /start。`);
  await bot.start({
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    onStart: () => {},
  });
} catch (e) {
  const message = e instanceof Error ? e.message : '启动失败';
  console.error(message.replaceAll(token, '[TOKEN]'));
  await shutdown();
  process.exitCode = 1;
}
