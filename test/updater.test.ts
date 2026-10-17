import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { c as tar } from 'tar';
import {
  UpdateManager,
  stageArchive,
  isSafeArchiveEntry,
  type UpdateManifest,
} from '../src/updater.js';
import { VERSION, REPOSITORY_URL, newerVersion } from '../src/version.js';
import {
  atomicJSON,
  readJSON,
  type ReleaseRef,
  type SupervisorState,
  type UpdateResult,
} from '../src/update-files.js';
import { Supervisor } from '../src/supervisor.js';

function temp() {
  return mkdtempSync(join(tmpdir(), 'dujiao-update-'));
}
function cleanup(path: string) {
  assert.equal(dirname(resolve(path)), resolve(tmpdir()));
  assert.ok(basename(path).startsWith('dujiao-update-'));
  rmSync(path, { recursive: true, force: true });
}
function manifest(version: string, archive = Buffer.from('test')): UpdateManifest {
  return {
    schema: 1,
    version,
    nodeMajor: 24,
    supervisorProtocol: 1,
    databaseSchema: 1,
    asset: `dujiao-stock-bot-${version}.tar.gz`,
    sha256: createHash('sha256').update(archive).digest('hex'),
    size: archive.length,
  };
}
function fakeApp(root: string, version: string, behavior = 'good') {
  mkdirSync(join(root, 'dist/src'), { recursive: true });
  mkdirSync(join(root, 'node_modules/grammy'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'dujiao-stock-bot', version, type: 'module' }),
  );
  writeFileSync(join(root, 'node_modules/grammy/package.json'), '{}');
  writeFileSync(
    join(root, 'dist/src/main.js'),
    `
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const db=new DatabaseSync(join(process.env.DATA_DIR,'bot.sqlite'));
db.exec("CREATE TABLE IF NOT EXISTS sample(value TEXT); INSERT INTO sample SELECT 'preserved' WHERE NOT EXISTS(SELECT 1 FROM sample)");
process.on('message',m=>{if(m.type==='shutdown'){db.close();process.exit(0);}if(m.type==='activate')writeFileSync(join(process.env.DATA_DIR,'observed'),'${version}');});
${behavior === 'bad' ? `db.exec("UPDATE sample SET value='corrupt'");db.close();process.exit(1);` : behavior === 'hang' ? 'setInterval(()=>{},1000);' : `process.send({type:'ready',version:'${version}'});`}
`,
  );
}
function downloaded(data: string, version: string, behavior = 'good'): ReleaseRef {
  const directory = `${version}-abcdef`;
  const root = join(data, 'releases', directory);
  fakeApp(root, version, behavior);
  atomicJSON(join(root, 'verified.json'), manifest(version));
  return { kind: 'download', version, directory };
}
function value(data: string) {
  const db = new DatabaseSync(join(data, 'bot.sqlite'));
  try {
    return (db.prepare('SELECT value FROM sample').get() as { value: string }).value;
  } finally {
    db.close();
  }
}

test('version matches package metadata and semver ordering is numeric', () => {
  assert.equal(VERSION, JSON.parse(readFileSync('package.json', 'utf8')).version);
  assert.ok(newerVersion('0.10.0', '0.2.0'));
  assert.equal(newerVersion('0.1.0', '0.1.0'), false);
  assert.equal(newerVersion('0.2.0-beta', '0.1.0'), false);
});
test('updater discovers only fixed-repository stable releases and validates manifest', async () => {
  const dir = temp();
  const m = manifest('0.2.0');
  const base = `${REPOSITORY_URL}/releases/download/v0.2.0/`;
  let calls = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    calls++;
    return new Response(
      JSON.stringify(
        String(input).includes('/releases/latest')
          ? {
              tag_name: 'v0.2.0',
              draft: false,
              prerelease: false,
              body: 'New features',
              assets: [
                {
                  name: 'update-manifest.json',
                  browser_download_url: base + 'update-manifest.json',
                },
                { name: m.asset, browser_download_url: base + m.asset },
              ],
            }
          : m,
      ),
    );
  }) as typeof fetch;
  try {
    const updater = new UpdateManager(dir, fetcher, '0.1.0');
    const available = await updater.check();
    assert.equal(available?.version, '0.2.0');
    await updater.check();
    assert.equal(calls, 2);
    const evil = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.2.0',
          assets: [
            { name: 'update-manifest.json', browser_download_url: 'https://evil.example/m.json' },
          ],
        }),
      )) as typeof fetch;
    await assert.rejects(new UpdateManager(dir, evil, '0.1.0').check(), /更新包发布/);
  } finally {
    cleanup(dir);
  }
});
test('no release and same version produce no update; GitHub errors are not false latest claims', async () => {
  const dir = temp();
  try {
    assert.equal(
      await new UpdateManager(
        dir,
        (async () => new Response('', { status: 404 })) as typeof fetch,
      ).check(),
      null,
    );
    assert.equal(
      await new UpdateManager(
        dir,
        (async () => new Response(JSON.stringify({ tag_name: 'v0.1.0' }))) as typeof fetch,
      ).check(),
      null,
    );
    await assert.rejects(
      new UpdateManager(
        dir,
        (async () => new Response('', { status: 403 })) as typeof fetch,
      ).check(),
      /受限/,
    );
  } finally {
    cleanup(dir);
  }
});
test('update archive hash, size, structure and extraction boundaries are enforced', async () => {
  const dir = temp();
  try {
    const source = join(dir, 'source'),
      data = join(dir, 'data');
    fakeApp(source, '0.2.0');
    const file = join(dir, 'bundle.tar.gz');
    await tar({ cwd: source, file, gzip: true }, ['package.json', 'dist', 'node_modules']);
    const bytes = readFileSync(file),
      m = manifest('0.2.0', bytes);
    const ref = await stageArchive(data, bytes, m);
    assert.equal(ref.kind, 'download');
    if (ref.kind === 'download')
      assert.ok(existsSync(join(data, 'releases', ref.directory, 'verified.json')));
    await assert.rejects(stageArchive(data, Buffer.from('bad'), m), /校验失败/);
    await assert.rejects(stageArchive(data, bytes, { ...m, version: '0.3.0' }), /版本号无效/);
    for (const path of [
      '../bot.sqlite',
      '/etc/passwd',
      'C:/data/file',
      'node_modules/../../bot.sqlite',
      'dist\\..\\bot.sqlite',
    ])
      assert.equal(isSafeArchiveEntry(path, 'File', ''), false);
    assert.equal(isSafeArchiveEntry('dist/x', 'SymbolicLink', '../../bot.sqlite'), false);
    assert.equal(isSafeArchiveEntry('node_modules/grammy/out/mod.js', 'File', ''), true);
  } finally {
    cleanup(dir);
  }
});
test('supervisor switches real child processes, keeps DB, and restores on failed startup', async () => {
  const dir = temp(),
    data = join(dir, 'data'),
    base = join(dir, 'base');
  fakeApp(base, '0.1.0');
  const supervisor = new Supervisor({
    dataDir: data,
    bundledDir: base,
    readyTimeoutMs: 15000,
    stopTimeoutMs: 3000,
  });
  try {
    await supervisor.start();
    assert.equal(value(data), 'preserved');
    await supervisor.install(downloaded(data, '0.2.0'));
    assert.equal(value(data), 'preserved');
    assert.equal(
      readJSON<SupervisorState | null>(join(data, 'supervisor.json'), null)?.active.version,
      '0.2.0',
    );
    await assert.rejects(supervisor.install(downloaded(data, '0.3.0', 'bad')), /就绪之前退出/);
    assert.equal(value(data), 'preserved');
    assert.equal(
      readJSON<SupervisorState | null>(join(data, 'supervisor.json'), null)?.active.version,
      '0.2.0',
    );
    assert.equal(
      readJSON<UpdateResult | null>(join(data, 'update-result.json'), null)?.status,
      'rollback',
    );
  } finally {
    await supervisor.stop();
    cleanup(dir);
  }
});
test('interrupted pending update restores previous app and database on next startup', async () => {
  const dir = temp(),
    data = join(dir, 'data'),
    base = join(dir, 'base');
  fakeApp(base, '0.1.0');
  const original = new Supervisor({
    dataDir: data,
    bundledDir: base,
    readyTimeoutMs: 15000,
    stopTimeoutMs: 3000,
  });
  let restarted: Supervisor | undefined;
  try {
    await original.start();
    await original.stop();
    const id = randomUUID();
    mkdirSync(join(data, 'update-backups'), { recursive: true });
    copyFileSync(join(data, 'bot.sqlite'), join(data, 'update-backups', `${id}.sqlite`));
    const db = new DatabaseSync(join(data, 'bot.sqlite'));
    db.exec("UPDATE sample SET value='partial migration'");
    db.close();
    atomicJSON(join(data, 'supervisor.json'), {
      active: { kind: 'bundled', version: '0.1.0' },
      pending: {
        from: { kind: 'bundled', version: '0.1.0' },
        to: { kind: 'download', version: '0.2.0', directory: '0.2.0-abcdef' },
        backup: `${id}.sqlite`,
        id,
      },
    });
    restarted = new Supervisor({
      dataDir: data,
      bundledDir: base,
      readyTimeoutMs: 15000,
      stopTimeoutMs: 3000,
    });
    await restarted.start();
    assert.equal(value(data), 'preserved');
    assert.equal(
      readJSON<UpdateResult | null>(join(data, 'update-result.json'), null)?.status,
      'rollback',
    );
  } finally {
    await restarted?.stop();
    await original.stop();
    cleanup(dir);
  }
});
