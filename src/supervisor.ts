import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { APP_ROOT, SUPERVISOR_PROTOCOL, newerVersion } from './version.js';
import {
  appPath,
  atomicJSON,
  managedPath,
  readJSON,
  releaseRefSchema,
  supervisorStateSchema,
  type ReleaseRef,
  type SupervisorState,
  type UpdateResult,
} from './update-files.js';
import { manifestSchema } from './updater.js';

interface Options {
  dataDir: string;
  bundledDir: string;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  onUnexpectedExit?: () => void;
}
export class Supervisor {
  private child: ChildProcess | undefined;
  private switching = false;
  private stopping = false;
  private state: SupervisorState;
  private readonly statePath: string;
  constructor(private options: Options) {
    options.dataDir = resolve(options.dataDir);
    options.bundledDir = resolve(options.bundledDir);
    mkdirSync(options.dataDir, { recursive: true });
    this.statePath = join(options.dataDir, 'supervisor.json');
    const bundled: ReleaseRef = {
      kind: 'bundled',
      version: JSON.parse(readFileSync(join(options.bundledDir, 'package.json'), 'utf8')).version,
    };
    this.state = supervisorStateSchema.parse(readJSON(this.statePath, { active: bundled }));
    // A new container image may contain a newer base app than the volume's active app.
    if (!this.state.pending && newerVersion(bundled.version, this.state.active.version))
      this.state = { active: bundled, previous: this.state.active };
  }
  private save() {
    atomicJSON(this.statePath, this.state);
  }
  private result(value: UpdateResult) {
    atomicJSON(join(this.options.dataDir, 'update-result.json'), value);
  }
  private verify(ref: ReleaseRef) {
    releaseRefSchema.parse(ref);
    const root = appPath(this.options.dataDir, this.options.bundledDir, ref);
    if (!existsSync(join(root, 'dist/src/main.js'))) throw new Error('更新版本缺少启动文件');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.version !== ref.version) throw new Error('启动版本与应用包不一致');
    if (ref.kind === 'download') {
      const manifest = manifestSchema.parse(readJSON(join(root, 'verified.json'), null));
      if (
        manifest.version !== ref.version ||
        manifest.supervisorProtocol > SUPERVISOR_PROTOCOL ||
        manifest.nodeMajor > Number(process.versions.node.split('.')[0])
      )
        throw new Error('更新版本不兼容当前容器');
    }
    return root;
  }
  private async stopChild(child: ChildProcess | undefined) {
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, this.options.stopTimeoutMs ?? 65000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.send({ type: 'shutdown' }, () => {});
      else child.kill('SIGTERM');
    });
  }
  private async launch(ref: ReleaseRef) {
    const root = this.verify(ref);
    const child = spawn(process.execPath, [join(root, 'dist/src/main.js')], {
      cwd: root,
      env: { ...process.env, DATA_DIR: this.options.dataDir, DUJIAO_SUPERVISED: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    child.on('message', (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'install' &&
        'release' in message &&
        !this.switching &&
        !this.stopping
      ) {
        void this.install(message.release).catch((e) =>
          console.error('更新失败：', e instanceof Error ? e.message : '未知错误'),
        );
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('新版启动超时'));
        }, this.options.readyTimeoutMs ?? 90000);
        const ready = (message: unknown) => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'ready'
          ) {
            cleanup();
            resolve();
          }
        };
        const exited = () => {
          cleanup();
          reject(new Error('应用在就绪之前退出'));
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.off('message', ready);
          child.off('exit', exited);
          child.off('error', failed);
        };
        child.on('message', ready);
        child.once('exit', exited);
        child.once('error', failed);
      });
    } catch (e) {
      await this.stopChild(child);
      throw e;
    }
    child.on('exit', () => {
      if (this.child === child && !this.switching && !this.stopping)
        this.options.onUnexpectedExit?.();
    });
    return child;
  }
  private snapshot(id: string): string | undefined {
    const dbPath = join(this.options.dataDir, 'bot.sqlite');
    if (!existsSync(dbPath)) return undefined;
    const db = new DatabaseSync(dbPath);
    try {
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
      if (checkpoint.busy) throw new Error('数据库仍被其他进程占用，取消更新');
    } finally {
      db.close();
    }
    const directory = join(this.options.dataDir, 'update-backups');
    mkdirSync(directory, { recursive: true });
    const name = `${id}.sqlite`;
    copyFileSync(dbPath, join(directory, name));
    return name;
  }
  private restore(backup: string | undefined) {
    const db = join(this.options.dataDir, 'bot.sqlite');
    // All child processes are stopped before this point. Only these managed SQLite files are replaced.
    for (const suffix of ['-wal', '-shm']) if (existsSync(db + suffix)) unlinkSync(db + suffix);
    if (backup) copyFileSync(managedPath(join(this.options.dataDir, 'update-backups'), backup), db);
    else if (existsSync(db)) unlinkSync(db);
  }
  async start() {
    if (this.state.pending) {
      const pending = this.state.pending;
      this.restore(pending.backup);
      this.state = { active: pending.from };
      this.save();
      this.result({
        id: pending.id,
        status: 'rollback',
        version: pending.from.version,
        message: '上次更新被中断，已恢复旧版本和更新前数据。',
        at: Date.now(),
      });
    }
    this.save();
    const child = await this.launch(this.state.active);
    child.send({ type: 'activate' });
  }
  async install(input: unknown) {
    if (this.switching || this.stopping) throw new Error('更新或停止正在进行');
    const ref = releaseRefSchema.parse(input);
    if (ref.kind !== 'download' || !newerVersion(ref.version, this.state.active.version))
      throw new Error('只能安装更高的正式版本');
    this.verify(ref);
    this.switching = true;
    const id = randomUUID(),
      previous = this.state.active;
    let oldStopped = false;
    let snapshotTaken = false;
    let snapshotBackup: string | undefined;
    try {
      await this.stopChild(this.child);
      oldStopped = true;
      if (this.stopping) throw new Error('服务正在停止，取消切换');
      const backup = this.snapshot(id);
      snapshotBackup = backup;
      snapshotTaken = true;
      this.state = { ...this.state, pending: { from: previous, to: ref, backup, id } };
      this.save();
      const child = await this.launch(ref);
      if (this.stopping) throw new Error('服务正在停止，取消切换');
      this.result({
        id,
        status: 'success',
        version: ref.version,
        message: `已更新到 v${ref.version}，配置和库存记录已保留。`,
        at: Date.now(),
      });
      this.state = { active: ref, previous };
      this.save();
      child.send({ type: 'activate' });
    } catch (e) {
      await this.stopChild(this.child);
      if (snapshotTaken) this.restore(snapshotBackup);
      this.state = { active: previous };
      this.save();
      this.result({
        id,
        status: 'rollback',
        version: previous.version,
        message: `更新失败，已恢复 v${previous.version}：${e instanceof Error ? e.message : '未知错误'}`,
        at: Date.now(),
      });
      if (oldStopped && !this.stopping) {
        const restored = await this.launch(previous);
        restored.send({ type: 'activate' });
      }
      throw e;
    } finally {
      this.switching = false;
    }
  }
  async stop() {
    this.stopping = true;
    await this.stopChild(this.child);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const supervisor = new Supervisor({
    dataDir: process.env.DATA_DIR || 'data',
    bundledDir: APP_ROOT,
    onUnexpectedExit: () => {
      process.exitCode = 1;
    },
  });
  process.once('SIGINT', () => void supervisor.stop());
  process.once('SIGTERM', () => void supervisor.stop());
  try {
    await supervisor.start();
  } catch (e) {
    console.error(e instanceof Error ? e.message : '启动失败');
    process.exitCode = 1;
    await supervisor.stop();
  }
}
