import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { stableVersion } from './version.js';

export const releaseRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundled'), version: z.string().refine(stableVersion) }).strict(),
  z
    .object({
      kind: z.literal('download'),
      version: z.string().refine(stableVersion),
      directory: z.string().regex(/^\d+\.\d+\.\d+-[a-zA-Z0-9]{6,20}$/),
    })
    .strict(),
]);
export type ReleaseRef = z.infer<typeof releaseRefSchema>;
export const supervisorStateSchema = z
  .object({
    active: releaseRefSchema,
    previous: releaseRefSchema.optional(),
    pending: z
      .object({
        from: releaseRefSchema,
        to: releaseRefSchema,
        backup: z
          .string()
          .regex(/^[a-zA-Z0-9.-]+\.sqlite$/)
          .optional(),
        id: z.string().uuid(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SupervisorState = z.infer<typeof supervisorStateSchema>;
export type UpdateResult = {
  id: string;
  status: 'success' | 'rollback' | 'failed';
  version: string;
  message: string;
  at: number;
};
export function readJSON<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}
export function atomicJSON(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`,
    fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
export function managedPath(parent: string, name: string) {
  const root = resolve(parent),
    target = resolve(root, name);
  if (target === root || !target.startsWith(root + sep)) throw new Error('更新目录越界');
  return target;
}
export function appPath(dataDir: string, bundledDir: string, ref: ReleaseRef) {
  releaseRefSchema.parse(ref);
  return ref.kind === 'bundled'
    ? bundledDir
    : managedPath(join(dataDir, 'releases'), ref.directory);
}
