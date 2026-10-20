import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaults, parseConfig, type Config } from './config.js';
import type { Job, MessagePayload } from './types.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (version > 1) throw new Error('数据库版本高于程序版本，不能降级运行');
    this.db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, dedupe TEXT NOT NULL UNIQUE, target TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,next_attempt);
      PRAGMA user_version=1;`);
    // A crash during HTTP delivery is ambiguous. Do not silently retransmit it.
    this.db
      .prepare(
        "UPDATE jobs SET status='uncertain',last_error='进程在发送期间退出，结果不确定，请在运行状态中处理' WHERE status='sending'",
      )
      .run();
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  delete(key: string) {
    this.db.prepare('DELETE FROM kv WHERE key=?').run(key);
  }
  config(): Config {
    return parseConfig(this.get('config', defaults()));
  }
  saveConfig(c: Config) {
    this.set('config', parseConfig(c));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  enqueue(dedupe: string, target: string, payload: MessagePayload) {
    this.db
      .prepare('INSERT OR IGNORE INTO jobs(dedupe,target,payload,created_at) VALUES(?,?,?,?)')
      .run(dedupe, target, JSON.stringify(payload), Date.now());
  }
  jobs(status = 'pending', now = Date.now()): Job[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE status=? AND next_attempt<=? ORDER BY id LIMIT 100')
      .all(status, now) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      dedupe: String(r.dedupe),
      target: String(r.target),
      payload: JSON.parse(String(r.payload)),
      status: String(r.status),
      attempts: Number(r.attempts),
      nextAttempt: Number(r.next_attempt),
      lastError: String(r.last_error),
    }));
  }
  updateJob(id: number, status: string, attempts: number, next: number, error = '') {
    this.db
      .prepare('UPDATE jobs SET status=?,attempts=?,next_attempt=?,last_error=? WHERE id=?')
      .run(status, attempts, next, error.slice(0, 1000), id);
  }
  dueJobs(now = Date.now()): Job[] {
    // Each target has a normal and a priority lane; paused work cannot hide system alerts.
    const rows = this.db
      .prepare(
        `SELECT * FROM (
      SELECT *, CASE WHEN dedupe LIKE 'system:%' OR dedupe LIKE 'emoji-fallback:%' THEN 2 WHEN dedupe LIKE 'periodic:%' THEN 1 ELSE 0 END AS urgent,
      ROW_NUMBER() OVER (PARTITION BY target, CASE WHEN dedupe LIKE 'system:%' OR dedupe LIKE 'emoji-fallback:%' THEN 2 WHEN dedupe LIKE 'periodic:%' THEN 1 ELSE 0 END ORDER BY id) AS position
      FROM jobs WHERE status='pending') WHERE position=1 AND next_attempt<=? ORDER BY urgent DESC,id LIMIT 100`,
      )
      .all(now) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      dedupe: String(r.dedupe),
      target: String(r.target),
      payload: JSON.parse(String(r.payload)),
      status: String(r.status),
      attempts: Number(r.attempts),
      nextAttempt: Number(r.next_attempt),
      lastError: String(r.last_error),
    }));
  }
  jobCounts() {
    return this.db.prepare('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status').all();
  }
  retryUncertain() {
    this.db
      .prepare(
        "UPDATE jobs SET status='pending', next_attempt=0 WHERE status IN ('uncertain','failed')",
      )
      .run();
  }
  cancelTarget(target: string) {
    this.db
      .prepare("UPDATE jobs SET status='cancelled' WHERE target=? AND status='pending'")
      .run(target);
  }
  cancelPendingPeriodic(target?: string) {
    if (target !== undefined)
      this.db
        .prepare(
          "UPDATE jobs SET status='cancelled' WHERE status='pending' AND dedupe LIKE 'periodic:%' AND target=?",
        )
        .run(target);
    else
      this.db
        .prepare(
          "UPDATE jobs SET status='cancelled' WHERE status='pending' AND dedupe LIKE 'periodic:%'",
        )
        .run();
  }
  prune() {
    this.db
      .prepare("DELETE FROM jobs WHERE status IN ('sent','cancelled') AND created_at<?")
      .run(Date.now() - 30 * 86400000);
  }
  close() {
    this.db.close();
  }
}
