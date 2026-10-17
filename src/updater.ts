import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { x as extract } from 'tar';
import { z } from 'zod';
import {
  REPOSITORY,
  REPOSITORY_URL,
  SUPERVISOR_PROTOCOL,
  VERSION,
  newerVersion,
  stableVersion,
} from './version.js';
import {
  atomicJSON,
  managedPath,
  type ReleaseRef,
  readJSON,
  type UpdateResult,
} from './update-files.js';

export const manifestSchema = z
  .object({
    schema: z.literal(1),
    version: z.string().refine(stableVersion),
    nodeMajor: z.number().int().min(24).max(100),
    supervisorProtocol: z.number().int().min(1),
    databaseSchema: z.literal(1),
    asset: z.string().regex(/^dujiao-stock-bot-\d+\.\d+\.\d+\.tar\.gz$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .positive()
      .max(40 * 1024 * 1024),
  })
  .strict();
export type UpdateManifest = z.infer<typeof manifestSchema>;
export interface AvailableUpdate {
  version: string;
  notes: string;
  url: string;
  manifest: UpdateManifest;
  assetURL: string;
}
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': `DujiaoStockBot/${VERSION}`,
};

async function bytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? '尚无可用的正式发行版或更新资产'
        : response.status === 403
          ? 'GitHub 请求受限，请稍后重试'
          : `更新服务器 HTTP ${response.status}`,
    );
  if (!response.body) throw new Error('更新服务器返回空响应');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.byteLength;
      if (total > limit) throw new Error('更新内容超过大小限制');
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export function validAssetURL(url: string, version: string, name: string) {
  return url === `${REPOSITORY_URL}/releases/download/v${version}/${name}`;
}
export function isSafeArchiveEntry(path: string, type: string, linkpath: string) {
  if (
    linkpath ||
    !['File', 'Directory', 'OldFile'].includes(type) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.includes(':')
  )
    return false;
  const clean = path.replace(/^\.\//, '').replace(/\/$/, '');
  if (clean === '') return type === 'Directory';
  if (clean.split('/').some((p) => p === '..' || p === '')) return false;
  return (
    clean === 'package.json' ||
    clean === 'package-lock.json' ||
    clean === 'dist' ||
    clean.startsWith('dist/') ||
    clean === 'node_modules' ||
    clean.startsWith('node_modules/')
  );
}
export async function stageArchive(
  dataDir: string,
  archive: Buffer,
  manifest: UpdateManifest,
): Promise<ReleaseRef> {
  manifestSchema.parse(manifest);
  if (
    archive.length !== manifest.size ||
    createHash('sha256').update(archive).digest('hex') !== manifest.sha256
  )
    throw new Error('更新包校验失败，旧版本保持运行');
  const releases = join(resolve(dataDir), 'releases');
  mkdirSync(releases, { recursive: true });
  const folder = mkdtempSync(join(releases, `${manifest.version}-`));
  const tarPath = join(resolve(dataDir), `update-${randomUUID()}.tar.gz`);
  writeFileSync(tarPath, archive, { mode: 0o600 });
  let invalid = false,
    expanded = 0,
    entries = 0;
  try {
    await extract({
      file: tarPath,
      cwd: folder,
      strict: true,
      preservePaths: false,
      noChmod: true,
      noMtime: true,
      filter: (path, entry) => {
        expanded += entry.size;
        entries++;
        if (
          !('type' in entry) ||
          !isSafeArchiveEntry(path, entry.type, entry.linkpath ?? '') ||
          expanded > 180 * 1024 * 1024 ||
          entries > 20000
        ) {
          invalid = true;
          return false;
        }
        return true;
      },
    });
    if (invalid) throw new Error('更新包包含不允许的路径、链接或过多文件');
    const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    if (
      pkg.name !== 'dujiao-stock-bot' ||
      pkg.version !== manifest.version ||
      !existsSync(join(folder, 'dist/src/main.js')) ||
      !existsSync(join(folder, 'node_modules/grammy/package.json'))
    )
      throw new Error('更新包结构或版本号无效');
    // The immutable supervisor only accepts fully extracted, verified release directories.
    atomicJSON(join(folder, 'verified.json'), manifest);
    return { kind: 'download', version: manifest.version, directory: relative(releases, folder) };
  } catch (e) {
    const checked = managedPath(releases, relative(releases, folder));
    if (checked !== resolve(folder) || !checked.startsWith(resolve(releases) + sep))
      throw new Error('拒绝清理异常路径');
    rmSync(checked, { recursive: true, force: true });
    throw e;
  } finally {
    if (existsSync(tarPath)) unlinkSync(tarPath);
  }
}
export class UpdateManager {
  private lastCheck = 0;
  private cached: AvailableUpdate | null = null;
  private installing = false;
  constructor(
    readonly dataDir: string,
    private fetcher: typeof fetch = fetch,
    readonly currentVersion = VERSION,
  ) {}
  status() {
    return readJSON<UpdateResult | null>(join(this.dataDir, 'update-result.json'), null);
  }
  get supported() {
    return Boolean(process.send && process.connected && process.env.DUJIAO_SUPERVISED === '1');
  }
  async check(): Promise<AvailableUpdate | null> {
    if (this.lastCheck && Date.now() - this.lastCheck < 30000) return this.cached;
    const response = await this.fetcher(
      `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (response.status === 404) {
      this.cached = null;
      this.lastCheck = Date.now();
      return null;
    }
    const release = JSON.parse((await bytes(response, 1024 * 1024)).toString('utf8'));
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (release.draft || release.prerelease || !stableVersion(version))
      throw new Error('发行版本信息无效');
    if (!newerVersion(version, this.currentVersion)) {
      this.cached = null;
      this.lastCheck = Date.now();
      return null;
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const manifestAsset = assets.find(
      (a: Record<string, unknown>) => a.name === 'update-manifest.json',
    );
    if (
      !manifestAsset ||
      !validAssetURL(manifestAsset.browser_download_url, version, 'update-manifest.json')
    )
      throw new Error('正式版尚未完成更新包发布，请稍后重试');
    const manifest = manifestSchema.parse(
      JSON.parse(
        (
          await bytes(
            await this.fetcher(manifestAsset.browser_download_url, {
              signal: AbortSignal.timeout(20000),
            }),
            16384,
          )
        ).toString('utf8'),
      ),
    );
    if (manifest.version !== version || manifest.asset !== `dujiao-stock-bot-${version}.tar.gz`)
      throw new Error('发行版本与更新包不匹配');
    if (
      manifest.nodeMajor > Number(process.versions.node.split('.')[0]) ||
      manifest.supervisorProtocol > SUPERVISOR_PROTOCOL
    )
      throw new Error('新版需要更新 Docker 基础镜像，请按部署文档拉取新镜像');
    const asset = assets.find((a: Record<string, unknown>) => a.name === manifest.asset);
    if (!asset || !validAssetURL(asset.browser_download_url, version, manifest.asset))
      throw new Error('更新包下载地址无效');
    this.cached = {
      version,
      notes: String(release.body || '').slice(0, 1800),
      url: `${REPOSITORY_URL}/releases/tag/v${version}`,
      manifest,
      assetURL: asset.browser_download_url,
    };
    this.lastCheck = Date.now();
    return this.cached;
  }
  async prepare(expectedVersion: string): Promise<ReleaseRef> {
    if (this.installing) throw new Error('已有更新正在准备');
    this.installing = true;
    try {
      const update = await this.check();
      if (!update || update.version !== expectedVersion)
        throw new Error('可更新版本已变化，请重新检查');
      const response = await this.fetcher(update.assetURL, { signal: AbortSignal.timeout(120000) });
      return await stageArchive(
        this.dataDir,
        await bytes(response, 40 * 1024 * 1024),
        update.manifest,
      );
    } finally {
      this.installing = false;
    }
  }
  requestInstall(ref: ReleaseRef) {
    if (!this.supported)
      throw new Error('当前不是可更新启动方式，请使用新版 Docker 镜像或 npm start 启动');
    process.send!({ type: 'install', release: ref });
  }
}
export async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
