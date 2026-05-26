import { mkdir } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const WORKSPACE_ENV = 'MAKEMYCLIP_WORKSPACE';

export function getWorkspace(): string {
  return process.env[WORKSPACE_ENV] ?? resolve(tmpdir(), 'makemyclip-editor');
}

export async function ensureWorkspace(): Promise<string> {
  const dir = getWorkspace();
  await mkdir(dir, { recursive: true });
  return dir;
}

export function resolveInput(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function newOutputPath(prefix: string, ext: string): string {
  const id = randomBytes(4).toString('hex');
  return resolve(getWorkspace(), `${prefix}-${id}.${ext}`);
}
