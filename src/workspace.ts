import { randomBytes } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

const MAX_SYMLINK_HOPS = 40;

/**
 * Canonicalize `p` for the workspace containment check: resolve symlinks on the
 * existing prefix so the comparison runs on REAL targets, while tolerating a
 * not-yet-created trailing path (a tool may be about to create it). Symlinks are
 * followed explicitly — including a DANGLING one, whose (possibly out-of-tree)
 * target is resolved so it can't be mistaken for an in-workspace leaf. Only a
 * genuine `ENOENT` is treated as a missing tail; any other error (`EACCES`,
 * `ELOOP`, a symlink cycle) throws so the caller can fail closed rather than
 * decide containment on a path it could not fully resolve.
 */
function canonicalizeForCheck(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  let hops = 0;
  for (;;) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      tail.unshift(basename(current));
      current = parent;
      continue;
    }
    if (stats.isSymbolicLink()) {
      if (++hops > MAX_SYMLINK_HOPS) {
        throw new Error(`Too many symlink hops resolving "${p}".`);
      }
      // Follow one hop toward the target (keeping the not-yet-resolved tail) so a
      // dangling or outward link is canonicalized to its real destination.
      current = resolve(dirname(current), readlinkSync(current));
      continue;
    }
    // A real, non-symlink entry: realpath collapses any symlinks in ITS prefix.
    const real = realpathSync(current);
    return tail.length > 0 ? resolve(real, ...tail) : real;
  }
}

/**
 * Resolve `path` and CONFINE it to the workspace — the trust boundary for
 * untrusted input (the agent's verbs/tools and the localhost `clip ui` routes).
 * Relative paths resolve against the workspace; absolute paths must already sit
 * inside it. Throws `WorkspaceBoundaryError` on traversal or any path outside the
 * tree. The trusted CLI keeps `resolveInput`, where a user-typed path is consent.
 *
 * Containment is checked on the REAL (symlink-collapsed) paths, so an in-workspace
 * symlink — existing-target OR dangling — cannot smuggle a read outside the tree:
 * each side is canonicalized via `canonicalizeForCheck` before comparing (a
 * symlinked workspace root, e.g. macOS `/var` -> `/private/var`, is collapsed too
 * so legit paths aren't falsely rejected). If a path can't be fully canonicalized
 * (permission error, symlink loop) it fails closed. The lexical resolved path is
 * returned, so an in-workspace symlink to an in-workspace target still works.
 *
 * Residual: an open-time TOCTOU race (the path is re-followed when FFmpeg opens
 * it) is not closed here — that needs `O_NOFOLLOW` at the open site.
 */
export function resolveInWorkspace(path: string): string {
  const workspace = getWorkspace();
  const resolved = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  let realWorkspace: string;
  let realResolved: string;
  try {
    realWorkspace = canonicalizeForCheck(workspace);
    realResolved = canonicalizeForCheck(resolved);
  } catch {
    // Couldn't canonicalize (EACCES / symlink loop / …) — don't decide on a
    // partially-resolved path; refuse.
    throw new WorkspaceBoundaryError(path, workspace);
  }
  const rel = relative(realWorkspace, realResolved);
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
