import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePackage = new URL('../package.json', import.meta.url);
const packagePath = existsSync(sourcePackage)
  ? sourcePackage
  : new URL('../../package.json', import.meta.url);
export const APP_ROOT = dirname(fileURLToPath(packagePath));
export const VERSION: string = JSON.parse(readFileSync(packagePath, 'utf8')).version;
export const REPOSITORY = 'a06342637/dujiaoshutongzhi';
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const SUPERVISOR_PROTOCOL = 1;
export const stableVersion = (v: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
export function newerVersion(candidate: string, current: string) {
  if (!stableVersion(candidate) || !stableVersion(current)) return false;
  const a = candidate.split('.').map(Number),
    b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}
