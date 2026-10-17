import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { c as tar } from 'tar';

const root = resolve('.'),
  pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`)
  throw new Error('Git tag and package.json version differ');
const out = join(root, 'release');
mkdirSync(out, { recursive: true });
const asset = `dujiao-stock-bot-${pkg.version}.tar.gz`;
await tar(
  {
    cwd: root,
    file: join(out, asset),
    gzip: true,
    portable: true,
    noMtime: true,
    filter: (path) => !path.startsWith('node_modules/.bin'),
  },
  ['package.json', 'package-lock.json', 'dist/src', 'node_modules'],
);
const content = readFileSync(join(out, asset));
const manifest = {
  schema: 1,
  version: pkg.version,
  nodeMajor: 24,
  supervisorProtocol: 1,
  databaseSchema: 1,
  asset,
  sha256: createHash('sha256').update(content).digest('hex'),
  size: statSync(join(out, asset)).size,
};
writeFileSync(join(out, 'update-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${asset}: ${manifest.size} bytes, sha256 ${manifest.sha256}`);
