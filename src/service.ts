import { randomUUID, createHash } from 'node:crypto';
import type { Config } from './config.js';
import { isEnabled } from './config.js';
import { DujiaoAdapter, FetchError } from './adapter.js';
import { advance, emptyEngine, mergeChanges } from './engine.js';
import {
  renderBoard,
  renderNotification,
  renderPeriodicNotification,
  escapeHTML,
  validateAppearance,
} from './render.js';
import type { Store } from './store.js';
import { DeliveryError, simpleMessage, type Transport } from './telegram.js';
import type { Batch, BoardRecord, EngineState, Product, Runtime, Scan } from './types.js';
import { AppLogger } from './logger.js';

const initialRuntime = (): Runtime => ({
  lastSuccess: 0,
  lastAttempt: 0,
  failures: 0,
  lastError: '',
  pages: 0,
  productCount: 0,
  siteName: '我的店铺',
  currency: 'CNY',
  nextCheck: 0,
});
interface PeriodicSchedule {
  signature: string;
  nextAt: number;
}
export class StockService {
  private activeCheck: Promise<{ ok: boolean; message: string }> | undefined;
  private scanning = false;
  private sending = false;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTargetSend = new Map<string, number>();
  private boardLocks = new Set<string>();
  constructor(
    readonly store: Store,
    readonly adapter: DujiaoAdapter,
    readonly transport: Transport,
    readonly adminId: string,
    readonly logs: AppLogger = new AppLogger(),
  ) {}
  runtime() {
    return this.store.get('runtime', initialRuntime());
  }
  state() {
    return this.store.get<EngineState>('engine', emptyEngine());
  }
  products(): Product[] {
    return this.store.get<Product[]>('catalog', Object.values(this.state().accepted));
  }
  report(text: string, key: string = randomUUID()) {
    this.logs.info('管理员状态通知', { message: text });
    this.store.enqueue(`system:${key}`, this.adminId, simpleMessage(escapeHTML(text)));
  }
  configure(c: Config) {
    validateAppearance(c);
    this.store.saveConfig(c);
    this.syncPeriodic(c);
    this.logs.info('设置已保存', {
      paused: c.paused,
      notifications: c.notifications,
      periodic: c.periodicNotifications,
      targets: c.targets.length,
    });
  }
  periodicNextAt() {
    return this.store.get<PeriodicSchedule | null>('periodic-schedule', null)?.nextAt ?? 0;
  }
  private syncPeriodic(c: Config, now = Date.now()): PeriodicSchedule | null {
    if (!c.periodicNotifications || c.paused || !c.siteUrl || !c.targets.some((t) => t.enabled)) {
      if (this.store.get('periodic-schedule', null) !== null) {
        this.store.delete('periodic-schedule');
        this.store.cancelPendingPeriodic();
      }
      return null;
    }
    const signature = JSON.stringify([c.siteUrl, c.apiUrl, c.timing.periodicInterval]);
    const existing = this.store.get<PeriodicSchedule | null>('periodic-schedule', null);
    if (existing?.signature === signature) return existing;
    this.store.cancelPendingPeriodic();
    const schedule = { signature, nextAt: now + c.timing.periodicInterval * 1000 };
    this.store.set('periodic-schedule', schedule);
    return schedule;
  }
  private enqueuePeriodic(scan: Scan, c: Config) {
    const schedule = this.syncPeriodic(c, scan.at);
    if (!schedule || scan.at < schedule.nextAt) return;
    const messages = renderPeriodicNotification(
        c,
        scan.products,
        scan.siteName,
        scan.currency,
        scan.at,
      ),
      id = randomUUID();
    for (const target of c.targets.filter((t) => t.enabled)) {
      // Expired, unsent snapshots should not burst into a recovered channel.
      this.store.cancelPendingPeriodic(target.id);
      messages.forEach((p, i) =>
        this.store.enqueue(`periodic:${id}:${target.id}:${i}`, target.id, p),
      );
    }
    this.store.set('periodic-schedule', {
      ...schedule,
      nextAt: scan.at + c.timing.periodicInterval * 1000,
    });
    this.logs.info('定时库存通知已加入队列', {
      targets: c.targets.filter((t) => t.enabled).length,
      parts: messages.length,
    });
  }
  async connect(siteUrl: string, apiUrl: string) {
    const c = this.store.config();
    c.siteUrl = siteUrl.replace(/\/+$/, '');
    c.apiUrl = apiUrl.replace(/\/+$/, '');
    const scan = await this.adapter.scan(c);
    const current = this.store.config();
    const changed = current.siteUrl !== c.siteUrl || current.apiUrl !== c.apiUrl;
    current.siteUrl = c.siteUrl;
    current.apiUrl = c.apiUrl;
    if (changed) current.products = {};
    this.store.transaction(() => {
      if (changed) {
        this.store.delete('engine');
        this.store.delete('batch');
        this.store.delete('boards');
        this.store.db.exec("UPDATE jobs SET status='cancelled' WHERE status='pending'");
      }
      this.store.saveConfig(current);
      this.commit(scan, current, true);
    });
    this.logs.info('网站连接成功', {
      host: new URL(current.siteUrl).hostname,
      products: scan.products.length,
      pages: scan.pages,
    });
    return scan;
  }
  private commit(scan: Scan, c: Config, baseline = false) {
    const oldRuntime = this.runtime();
    const result = advance(baseline ? emptyEngine() : this.state(), scan.products, c, scan.at);
    this.store.set('engine', result.state);
    this.store.set('catalog', scan.products);
    this.store.saveConfig(c);
    if (c.notifications && !c.paused && result.events.length) {
      const batch = this.store.get<Batch | null>('batch', null) ?? {
        id: randomUUID(),
        openedAt: scan.at,
        events: [],
      };
      batch.events.push(...result.events);
      this.store.set('batch', batch);
    }
    this.store.set('runtime', {
      ...oldRuntime,
      lastSuccess: scan.at,
      failures: 0,
      lastError: '',
      pages: scan.pages,
      productCount: scan.products.length,
      siteName: scan.siteName,
      currency: scan.currency,
      nextCheck: Math.max(oldRuntime.lastAttempt + c.timing.interval * 1000, Date.now()),
    });
    if (oldRuntime.failures >= 3) this.report('店铺连接已恢复。');
    this.enqueuePeriodic(scan, c);
    return result.events.length;
  }
  async check(force = false): Promise<string> {
    return (await this.startCheck(force)).message;
  }
  private startCheck(force: boolean): Promise<{ ok: boolean; message: string }> {
    if (this.activeCheck)
      return Promise.resolve({ ok: false, message: '已有检查正在进行，请稍后重试。' });
    const pending = this.collect(force).finally(() => {
      if (this.activeCheck === pending) this.activeCheck = undefined;
    });
    this.activeCheck = pending;
    return pending;
  }
  async freshInventory(): Promise<Scan> {
    const result = await (this.activeCheck ?? this.startCheck(true));
    if (!result.ok) throw new Error(`无法读取当前库存：${result.message}`);
    const rt = this.runtime();
    return {
      products: this.products(),
      at: rt.lastSuccess,
      siteName: rt.siteName,
      currency: rt.currency,
      pages: rt.pages,
    };
  }
  private async collect(force = false): Promise<{ ok: boolean; message: string }> {
    if (this.scanning) return { ok: false, message: '已有检查正在进行，请稍后重试。' };
    const c = this.store.config();
    if (!c.siteUrl) return { ok: false, message: '请先连接网站。' };
    if (c.paused && !force) return { ok: false, message: '监测已暂停。' };
    const cooldown = this.store.get('site-cooldown', 0);
    if (Date.now() < cooldown)
      return {
        ok: false,
        message: `网站限流等待中，${Math.ceil((cooldown - Date.now()) / 1000)} 秒后可重试。`,
      };
    this.scanning = true;
    const siteKey = `${c.siteUrl}|${c.apiUrl}`;
    this.store.set('runtime', { ...this.runtime(), lastAttempt: Date.now() });
    try {
      const scan = await this.adapter.scan(c);
      const current = this.store.config();
      if (`${current.siteUrl}|${current.apiUrl}` !== siteKey)
        return { ok: false, message: '检查期间网站配置已更改，已丢弃旧网站结果。' };
      const changes = this.store.transaction(() => {
        const count = this.commit(scan, current);
        this.flush(Date.now());
        return count;
      });
      this.logs.info('库存检查成功', {
        products: scan.products.length,
        pages: scan.pages,
        changes,
      });
      return { ok: true, message: `检查成功：${scan.products.length} 个商品，${scan.pages} 页。` };
    } catch (e) {
      const rt = this.runtime(),
        failures = rt.failures + 1,
        message = e instanceof Error ? e.message : '检查失败';
      const wait = Math.max(
        (c.periodicNotifications && !c.paused && c.targets.some((t) => t.enabled)
          ? Math.min(c.timing.interval, c.timing.periodicInterval)
          : c.timing.interval) * 1000,
        Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6)),
        e instanceof FetchError ? e.retryAfter : 0,
      );
      if (e instanceof FetchError && e.retryAfter)
        this.store.set('site-cooldown', Date.now() + e.retryAfter);
      this.store.set('runtime', {
        ...rt,
        failures,
        lastError: message,
        nextCheck: Date.now() + wait,
      });
      // Consecutive successful observations must not span an interrupted/incomplete scan.
      const state = this.state();
      state.candidates = {};
      state.missing = {};
      this.store.set('engine', state);
      if (failures === 3) this.report(`店铺连续 3 次检查失败，已退避重试。\n${message}`);
      this.logs.error('库存检查失败', {
        error: message,
        failures,
        retrySeconds: Math.ceil(wait / 1000),
      });
      return { ok: false, message: `检查失败：${message}` };
    } finally {
      this.scanning = false;
    }
  }
  flush(now = Date.now()) {
    const batch = this.store.get<Batch | null>('batch', null);
    if (!batch) return;
    const c = this.store.config();
    if (now < batch.openedAt + c.timing.mergeWindow * 1000) return;
    if (c.notifications && !c.paused) {
      const events = mergeChanges(batch.events, c);
      if (events.length) {
        const rt = this.runtime();
        const messages = renderNotification(
          c,
          this.products(),
          events,
          rt.siteName,
          rt.currency,
          rt.lastSuccess,
        );
        for (const target of c.targets.filter((t) => t.enabled))
          messages.forEach((p, i) =>
            this.store.enqueue(`${batch.id}:${target.id}:${i}`, target.id, p),
          );
      }
    }
    this.store.delete('batch');
  }
  async sendDue(now = Date.now()) {
    if (this.sending || this.store.get('telegram-cooldown', 0) > now) return;
    this.sending = true;
    try {
      const config = this.store.config();
      const enabled = new Set(config.targets.filter((t) => t.enabled).map((t) => t.id));
      const attempted = new Set<string>();
      const deliveries: Promise<void>[] = [];
      for (const job of this.store.dueJobs(now)) {
        const periodic = job.dedupe.startsWith('periodic:');
        if (
          attempted.has(job.target) ||
          (this.lastTargetSend.get(job.target) ?? 0) > now - 1100 ||
          this.store.get(`target-cooldown:${job.target}`, 0) > now
        )
          continue;
        if (
          !job.dedupe.startsWith('system:') &&
          !job.dedupe.startsWith('emoji-fallback:') &&
          (!enabled.has(job.target) ||
            !(periodic ? config.periodicNotifications : config.notifications) ||
            config.paused)
        ) {
          if (!enabled.has(job.target) || periodic)
            this.store.updateJob(job.id, 'cancelled', job.attempts, 0);
          continue;
        }
        attempted.add(job.target);
        this.lastTargetSend.set(job.target, now);
        this.store.updateJob(job.id, 'sending', job.attempts + 1, 0);
        deliveries.push(
          (async () => {
            try {
              await this.transport.send(job.target, job.payload);
              this.store.updateJob(job.id, 'sent', job.attempts + 1, 0);
              this.logs.info('Telegram 通知发送成功', {
                target: job.target,
                job: job.id,
                type: periodic ? 'periodic' : 'notification',
              });
            } catch (e) {
              const error =
                e instanceof DeliveryError ? e : new DeliveryError('发送结果未知', 'uncertain');
              const state =
                error.kind === 'uncertain'
                  ? 'uncertain'
                  : error.kind === 'permanent'
                    ? 'failed'
                    : 'pending';
              const delay =
                error.kind === 'rate'
                  ? error.retryAfter
                  : Math.min(3600000, 5000 * 2 ** Math.min(job.attempts, 10));
              if (error.kind === 'rate') {
                this.lastTargetSend.set(job.target, now + delay);
                this.store.set(`target-cooldown:${job.target}`, now + delay);
                this.store.set('telegram-cooldown', now + delay);
              }
              this.store.updateJob(job.id, state, job.attempts + 1, now + delay, error.message);
              this.logs.error('Telegram 通知发送失败', {
                target: job.target,
                job: job.id,
                status: state,
                error: error.message,
              });
              if ((state === 'uncertain' || state === 'failed') && job.target !== this.adminId)
                this.report(
                  `目标 ${job.target} 发送${state === 'uncertain' ? '结果不确定' : '失败'}：${error.message}\n可在运行状态中处理。`,
                  `job:${job.id}`,
                );
            }
          })(),
        );
        if (attempted.size >= 10) break;
      }
      await Promise.all(deliveries);
    } finally {
      this.sending = false;
    }
  }
  async board(target: string, page?: number, force = false): Promise<string> {
    if (this.boardLocks.has(target)) return '看板正在更新。';
    const c = this.store.config(),
      rt = this.runtime();
    if (!c.board || !rt.lastSuccess) return '看板尚未开启或没有库存数据。';
    if (!c.targets.some((t) => t.id === target && t.enabled)) return '通知目标未启用。';
    if (
      Math.max(
        this.store.get(`target-cooldown:${target}`, 0),
        this.store.get('telegram-cooldown', 0),
      ) > Date.now()
    )
      return 'Telegram 限流等待中。';
    if (this.store.get(`board-uncertain:${target}`, false))
      return '看板创建结果不确定，请在看板菜单确认后重建。';
    this.boardLocks.add(target);
    try {
      const boards = this.store.get<Record<string, BoardRecord>>('boards', {}),
        record = boards[target];
      if (!force && record && Date.now() - record.updatedAt < c.timing.boardInterval * 1000)
        return '等待看板更新间隔。';
      const products = this.products();
      const rendered = renderBoard(
        c,
        products,
        rt.siteName,
        rt.currency,
        rt.lastSuccess,
        page ?? record?.page ?? 0,
      );
      const signature = createHash('sha256')
        .update(
          JSON.stringify([
            c.appearance,
            c.products,
            c.timing.pageSize,
            products.filter((p) => isEnabled(c, p.id)),
            rt.siteName,
            rt.currency,
            rendered.page,
          ]),
        )
        .digest('hex');
      if (!force && record?.signature === signature) return '内容没有变化。';
      let id = record?.messageId;
      if (id) {
        try {
          await this.transport.edit(target, id, rendered.payload);
        } catch (e) {
          if (
            e instanceof DeliveryError &&
            /message to edit not found|message can't be edited/i.test(e.message)
          )
            id = undefined;
          else throw e;
        }
      }
      if (!id) {
        // Persist the creation marker before the network call; it survives crashes.
        this.store.set(`board-uncertain:${target}`, true);
        try {
          id = await this.transport.send(target, rendered.payload);
        } catch (e) {
          if (e instanceof DeliveryError && e.kind !== 'uncertain')
            this.store.delete(`board-uncertain:${target}`);
          throw e;
        }
      }
      const current = this.store.get<Record<string, BoardRecord>>('boards', {});
      current[target] = { messageId: id, page: rendered.page, signature, updatedAt: Date.now() };
      this.store.transaction(() => {
        this.store.set('boards', current);
        this.store.delete(`board-uncertain:${target}`);
      });
      this.store.delete(`board-error:${target}`);
      this.logs.info('库存看板已更新', { target, page: rendered.page + 1 });
      return '看板已更新。';
    } catch (e) {
      const error = e instanceof Error ? e.message : '看板更新失败';
      this.store.set(`board-error:${target}`, error);
      this.logs.error('库存看板更新失败', { target, error });
      const delay = e instanceof DeliveryError && e.kind === 'rate' ? e.retryAfter : 60000;
      this.store.set(`target-cooldown:${target}`, Date.now() + delay);
      if (e instanceof DeliveryError && e.kind === 'rate')
        this.store.set('telegram-cooldown', Date.now() + delay);
      const last = this.store.get(`board-alert:${target}`, 0);
      if (Date.now() - last > 3600000) {
        this.report(`目标 ${target} 看板更新失败：${error}`);
        this.store.set(`board-alert:${target}`, Date.now());
      }
      return error;
    } finally {
      this.boardLocks.delete(target);
    }
  }
  resetBoard(target: string) {
    const boards = this.store.get<Record<string, BoardRecord>>('boards', {});
    delete boards[target];
    this.store.set('boards', boards);
    this.store.delete(`board-uncertain:${target}`);
    this.store.delete(`target-cooldown:${target}`);
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch((e) => {
        this.store.set('service-error', String(e));
        this.logs.error('后台任务异常', { error: String(e) });
      });
    }, 1000);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const c = this.store.config(),
        rt = this.runtime();
      const periodic = this.syncPeriodic(c),
        periodicDue = periodic !== null && Date.now() >= periodic.nextAt;
      const due = rt.failures
        ? rt.nextCheck
        : Math.min(rt.nextCheck, rt.lastAttempt + c.timing.interval * 1000);
      if (
        !c.paused &&
        c.siteUrl &&
        (Date.now() >= due || (periodicDue && !rt.failures)) &&
        !this.scanning
      )
        void this.check().catch((e) => this.logs.error('检查任务异常', { error: String(e) }));
      this.store.transaction(() => this.flush());
      void this.sendDue().catch((e) => {
        this.store.set('service-error', String(e));
        this.logs.error('发送队列异常', { error: String(e) });
      });
      if (!c.paused && c.board)
        for (const t of c.targets.filter((t) => t.enabled))
          void this.board(t.id).catch((e) => {
            this.store.set('service-error', String(e));
            this.logs.error('看板任务异常', { target: t.id, error: String(e) });
          });
      if (Date.now() - this.store.get('last-prune', 0) > 3600000) {
        this.store.prune();
        this.store.set('last-prune', Date.now());
      }
    } finally {
      this.ticking = false;
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    while (this.scanning || this.ticking || this.sending || this.boardLocks.size)
      await new Promise((r) => setTimeout(r, 50));
  }
}
