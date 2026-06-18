import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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

/** Thrown when an untrusted surface (agent verb/tool, `clip ui` route) asks to
 *  read a path outside the workspace — the AGENTS.md non-negotiable #3 boundary. */
export class WorkspaceBoundaryError extends Error {
  readonly path: string;
  readonly workspace: string;
  constructor(path: string, workspace: string) {
    // Audience-neutral: served both to the agent (as tool-result data) and to a
    // person via the 403 body, so it states the constraint without advising a
    // surface only one of them has (no "use the CLI" — the agent cannot).
    super(
      `Refusing to read "${path}": it is outside the workspace (${workspace}). ` +
        `Only files inside the workspace can be read here — move the file into the ` +
        `workspace (its imports/ folder) and reference it from there.`,
    );
    this.name = 'WorkspaceBoundaryError';
    this.path = path;
    this.workspace = workspace;
  }
}

/**
 * Resolve `path` and CONFINE it to the workspace — the trust boundary for
 * untrusted input (the agent's verbs/tools and the localhost `clip ui` routes).
 * Relative paths resolve against the workspace; absolute paths must already sit
 * inside it. Throws `WorkspaceBoundaryError` on traversal or any path outside the
 * tree. The trusted CLI keeps `resolveInput`, where a user-typed path is consent.
 *
 * Containment is by resolved-path prefix; it does NOT follow symlinks, so a
 * symlink placed inside the workspace can still point out — hardening that is a
 * follow-up, but `..`-traversal and absolute out-of-tree paths are rejected here.
 */
export function resolveInWorkspace(path: string): string {
  const workspace = getWorkspace();
  const resolved = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  const rel = relative(workspace, resolved);
  // Outside the tree if the relative path is empty (the workspace dir itself),
  // escapes via '..', or is absolute (e.g. a different Windows drive).
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceBoundaryError(path, workspace);
  }
  return resolved;
}

export function newOutputPath(prefix: string, ext: string): string {
  const id = randomBytes(4).toString('hex');
  return resolve(getWorkspace(), `${prefix}-${id}.${ext}`);
}
