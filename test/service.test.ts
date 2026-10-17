import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { Store } from '../src/store.js';
import { defaults } from '../src/config.js';
import { DujiaoAdapter, FetchError } from '../src/adapter.js';
import { StockService } from '../src/service.js';
import { DeliveryError, simpleMessage, type Transport } from '../src/telegram.js';
import type { MessagePayload, Scan } from '../src/types.js';
import { product, scan } from './fixtures.js';

class FakeAdapter extends DujiaoAdapter {
  next: Scan | Error = scan([product(8)]);
  calls = 0;
  override async scan() {
    this.calls++;
    if (this.next instanceof Error) throw this.next;
    return { ...this.next, at: Date.now() };
  }
}
class FakeTransport implements Transport {
  messages: { target: string; payload: MessagePayload }[] = [];
  edits: { target: string; id: number; payload: MessagePayload }[] = [];
  failures = new Map<string, DeliveryError>();
  async send(target: string, payload: MessagePayload) {
    if (this.failures.has(target)) throw this.failures.get(target)!;
    this.messages.push({ target, payload });
    return this.messages.length;
  }
  async edit(target: string, id: number, payload: MessagePayload) {
    if (this.failures.has(target)) throw this.failures.get(target)!;
    this.edits.push({ target, id, payload });
  }
}
function fixture() {
  const store = new Store(':memory:'),
    adapter = new FakeAdapter(),
    transport = new FakeTransport();
  const c = defaults();
  c.siteUrl = 'https://shop.example';
  c.timing.mergeWindow = 0;
  c.targets = [
    { id: '-1001', title: '一', enabled: true },
    { id: '-1002', title: '二', enabled: true },
  ];
  store.saveConfig(c);
  return { store, adapter, transport, service: new StockService(store, adapter, transport, '1') };
}
test('baseline, transactional queue creation, failed target isolation and restart deduplication', async () => {
  const f = fixture();
  try {
    await f.service.check();
    assert.equal(f.store.jobs().length, 0);
    f.adapter.next = scan([product(7)]);
    await f.service.check();
    assert.equal(f.store.jobs().length, 2);
    f.transport.failures.set('-1001', new DeliveryError('无权限', 'permanent'));
    await f.service.sendDue();
    assert.equal(f.store.jobs('failed', Number.MAX_SAFE_INTEGER).length, 1);
    assert.equal(f.transport.messages[0]!.target, '-1002');
    const afterRestart = new StockService(f.store, f.adapter, f.transport, '1');
    await afterRestart.check();
    assert.equal(f.store.jobs().filter((j) => j.target.startsWith('-')).length, 0);
  } finally {
    f.store.close();
  }
});
test('failures preserve stock and produce one alert after three errors and one on recovery', async () => {
  const f = fixture();
  try {
    await f.service.check();
    f.adapter.next = new FetchError('HTTP 503');
    await f.service.check();
    await f.service.check();
    await f.service.check();
    await f.service.check();
    assert.equal(f.store.jobs().length, 1);
    assert.equal(f.service.state().accepted['1']!.stock.kind, 'exact');
    f.adapter.next = scan([product(8)]);
    await f.service.check();
    assert.equal(f.store.jobs().length, 2);
    assert.equal(f.service.runtime().failures, 0);
  } finally {
    f.store.close();
  }
});
test('uncertain sends held for explicit retry and rate limit survives restart', async () => {
  const f = fixture();
  try {
    f.store.enqueue('a', '-1001', simpleMessage('测试'));
    f.transport.failures.set('-1001', new DeliveryError('响应丢失', 'uncertain'));
    await f.service.sendDue();
    assert.equal(f.store.jobs('uncertain', Number.MAX_SAFE_INTEGER).length, 1);
    await f.service.sendDue(Date.now() + 60000);
    assert.equal(f.store.jobs('uncertain', Number.MAX_SAFE_INTEGER)[0]!.attempts, 1);
    f.store.retryUncertain();
    f.transport.failures.set('-1001', new DeliveryError('限流', 'rate', 120000));
    await f.service.sendDue(Date.now() + 2000);
    assert.ok(f.store.get('target-cooldown:-1001', 0) > Date.now() + 100000);
    f.transport.failures.clear();
    const restarted = new StockService(f.store, f.adapter, f.transport, '1');
    await restarted.sendDue();
    assert.equal(f.transport.messages.filter((m) => m.target === '-1001').length, 0);
  } finally {
    f.store.close();
  }
});
test('board not edited for unchanged data and edits changed content', async () => {
  const f = fixture();
  try {
    await f.service.check();
    await f.service.board('-1001', 0, true);
    assert.equal(f.transport.messages.length, 1);
    const boards = f.store.get<Record<string, { updatedAt: number }>>('boards', {});
    boards['-1001']!.updatedAt = 0;
    f.store.set('boards', boards);
    await f.service.check();
    await f.service.board('-1001');
    assert.equal(f.transport.edits.length, 0);
    f.adapter.next = scan([product(2)]);
    await f.service.check();
    await f.service.board('-1001', 0, true);
    assert.equal(f.transport.edits.length, 1);
  } finally {
    f.store.close();
  }
});
test('ambiguous board creation does not create an endless stream of boards', async () => {
  const f = fixture();
  try {
    await f.service.check();
    f.transport.failures.set('-1001', new DeliveryError('响应丢失', 'uncertain'));
    await f.service.board('-1001', 0, true);
    assert.equal(f.store.get('board-uncertain:-1001', false), true);
    f.transport.failures.clear();
    f.store.delete('target-cooldown:-1001');
    assert.match(await f.service.board('-1001', 0, true), /不确定/);
    assert.equal(f.transport.messages.length, 0);
    f.service.resetBoard('-1001');
    await f.service.board('-1001', 0, true);
    assert.equal(f.transport.messages.length, 1);
  } finally {
    f.store.close();
  }
});
test('missing public stock is displayed unknown while comparison keeps last known stock', async () => {
  const f = fixture();
  try {
    await f.service.check();
    const p = product();
    p.stock = { kind: 'unknown' };
    p.skus[0]!.stock = { kind: 'unknown' };
    f.adapter.next = scan([p]);
    await f.service.check();
    assert.equal(f.service.products()[0]!.stock.kind, 'unknown');
    assert.equal(f.service.state().accepted['1']!.stock.kind, 'exact');
    assert.equal(f.store.jobs().length, 0);
  } finally {
    f.store.close();
  }
});
test('no overlapping scans even when manually triggered', async () => {
  const f = fixture();
  let done: (s: Scan) => void = () => {};
  f.adapter.scan = () =>
    new Promise<Scan>((resolve) => {
      done = resolve;
    });
  try {
    const running = f.service.check();
    assert.match(await f.service.check(true), /已有检查/);
    done(scan([product()]));
    await running;
  } finally {
    f.store.close();
  }
});
test('a slow Telegram target does not block delivery to another target', async () => {
  const f = fixture();
  let release: () => void = () => {};
  const delivered: string[] = [];
  f.transport.send = async (target: string) => {
    if (target === '-1001')
      await new Promise<void>((r) => {
        release = r;
      });
    delivered.push(target);
    return 1;
  };
  try {
    f.store.enqueue('slow', '-1001', simpleMessage('慢'));
    f.store.enqueue('fast', '-1002', simpleMessage('快'));
    const sending = f.service.sendDue();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(delivered, ['-1002']);
    release();
    await sending;
  } finally {
    f.store.close();
  }
});
test('SQLite persists config, snapshots, draft and ambiguous in-flight delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dujiao-test-')),
    path = join(dir, 'state.sqlite');
  try {
    let store = new Store(path);
    const c = defaults();
    c.siteUrl = 'https://shop.example';
    store.saveConfig(c);
    store.set('draft', { appearance: c.appearance, products: {} });
    store.set('engine', {
      initialized: true,
      accepted: { '1': product() },
      candidates: {},
      missing: {},
    });
    store.enqueue('persist', '-1', simpleMessage('测试'));
    const j = store.jobs()[0]!;
    store.updateJob(j.id, 'sending', 1, 0);
    store.close();
    store = new Store(path);
    assert.equal(store.config().siteUrl, c.siteUrl);
    assert.ok(store.get('draft', null));
    assert.equal(store.jobs('uncertain', Number.MAX_SAFE_INTEGER).length, 1);
    store.close();
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('dujiao-test-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
test('transaction rollback never leaves half a snapshot and half a queue', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() =>
      store.transaction(() => {
        store.set('engine', { initialized: true });
        store.enqueue('rollback', '1', simpleMessage('测试'));
        throw new Error('模拟写入失败');
      }),
    );
    assert.equal(store.get('engine', null), null);
    assert.equal(store.jobs().length, 0);
  } finally {
    store.close();
  }
});
test('large queue for one target does not starve other targets or administrator alerts', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 150; i++) f.store.enqueue(`old-${i}`, '-1001', simpleMessage('old'));
    f.store.enqueue('other', '-1002', simpleMessage('other'));
    f.service.report('administrator alert');
    await f.service.sendDue();
    assert.ok(f.transport.messages.some((m) => m.target === '-1002'));
    assert.ok(f.transport.messages.some((m) => m.target === '1'));
  } finally {
    f.store.close();
  }
});
