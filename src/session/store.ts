import { randomBytes } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ensureWorkspace, getWorkspace } from '../workspace.js';
import { type Session, type SessionEntry, SessionSchema } from './types.js';

const SESSION_FILE = 'session.json';

/** How many times a serialized mutation re-reads + retries when the on-disk rev
 *  moved under it. In-process writes are fully serialized by `runExclusive`, so
 *  this only engages for cross-process writers (e.g. a CLI command run while
 *  `clip ui` is open) — and even then detection is best-effort (see the note on
 *  `mutateSession`). */
const MAX_MUTATE_ATTEMPTS = 8;

export function sessionPath(): string {
  return resolve(getWorkspace(), SESSION_FILE);
}

export function snapshotsDir(): string {
  return resolve(getWorkspace(), 'snapshots');
}

export function snapshotPath(label: string): string {
  return resolve(snapshotsDir(), `${label}.json`);
}

/**
 * Thrown when the session file exists but cannot be parsed/validated. We
 * deliberately surface this instead of silently resetting to an empty session —
 * a corrupt file (or a torn write from an older build) used to vanish the user's
 * entire history with no signal. Callers should show it, not swallow it.
 */
export class SessionCorruptError extends Error {
  readonly path: string;
  constructor(path: string, options?: { cause?: unknown }) {
    super(
      `Session file is corrupt and was not loaded: ${path}. ` +
        `Recover with \`clip undo <snapshotLabel>\`, or remove the file to start fresh ` +
        `(\`clip inspect\` still works and will report this) — refusing to silently discard history.`,
      options,
    );
    this.name = 'SessionCorruptError';
    this.path = path;
  }
}

/**
 * Thrown by `writeSessionIfUnchanged` when the on-disk `rev` no longer matches
 * the revision the caller based its edit on — i.e. another writer committed in
 * between. The caller should re-read and reapply rather than clobber.
 */
export class SessionConflictError extends Error {
  readonly expectedRev: number;
  readonly actualRev: number;
  constructor(expectedRev: number, actualRev: number) {
    super(
      `Session write rejected: expected rev ${expectedRev} but on-disk rev is ${actualRev}. ` +
        `Another writer committed first — re-read and reapply.`,
    );
    this.name = 'SessionConflictError';
    this.expectedRev = expectedRev;
    this.actualRev = actualRev;
  }
}

/** A fresh empty session. NOT a shared singleton — every caller gets its own
 *  `entries` array so no two callers can alias and mutate the same backing array. */
function freshEmpty(): Session {
  return { version: 1, rev: 0, entries: [] };
}

// ─── In-process single-writer serialization ──────────────────────────────────
//
// Every mutation runs through this promise chain, so two concurrent callers in
// the SAME process (the embedded chat agent and a UI request both calling
// `appendOp`) can never interleave their read-modify-write and lose an entry.
// Reads are intentionally NOT serialized: atomic writes mean a reader always
// sees a complete file, so reads stay lock-free.
let writeChain: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive regardless of whether `fn` resolved or rejected.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function readSession(): Promise<Session> {
  await ensureWorkspace();
  let raw: string;
  try {
    raw = await readFile(sessionPath(), 'utf-8');
  } catch (err: unknown) {
    // Missing file → a fresh workspace has no session yet. That is the ONLY
    // condition under which we manufacture an empty session; any other read
    // failure (permissions, etc.) is a real error and propagates.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return freshEmpty();
    }
    throw err;
  }
  try {
    return SessionSchema.parse(JSON.parse(raw));
  } catch (err) {
    // The file exists but is unparseable/invalid — surface it, don't discard it.
    throw new SessionCorruptError(sessionPath(), { cause: err });
  }
}

/**
 * Atomically write `data` to `filePath`: create the directory if needed, write a
 * uniquely-named temp file beside the target, fsync it, `rename` over the target,
 * then fsync the directory. `rename` within one filesystem is atomic, so a reader
 * never observes a half-written file; the directory fsync makes the rename itself
 * crash-durable. Any failure unlinks the temp so a failing (or retrying) write
 * never litters the directory. This is the shared durability primitive for both
 * the session log and snapshots — the snapshot is a recovery source, so it must
 * be as torn-write-safe as the file it recovers.
 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = resolve(dir, `.${randomBytes(6).toString('hex')}.tmp`);

  // Write + fsync the temp file. On ANY failure (ENOSPC, EIO, EDQUOT, …) unlink
  // the partial temp before rethrowing — leaving it would orphan one file per
  // failed/retried write.
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }

  await fsyncDir(dir);
}

/**
 * Atomically persist a session log. Does NOT touch `rev` — callers own the bump.
 */
export async function writeSession(session: Session): Promise<void> {
  await atomicWriteFile(sessionPath(), `${JSON.stringify(session, null, 2)}\n`);
}

/** Atomically persist a snapshot under its label. */
export async function writeSnapshot(label: string, session: Session): Promise<void> {
  await atomicWriteFile(snapshotPath(label), `${JSON.stringify(session, null, 2)}\n`);
}

/**
 * Read + validate a snapshot. A missing snapshot is a clear "no such label"
 * error; a present-but-unparseable one throws `SessionCorruptError` (so a torn
 * snapshot surfaces the same way a torn live log does, instead of a raw Zod/JSON
 * stack) — the recovery path must fail legibly, not cryptically.
 */
export async function readSnapshot(label: string): Promise<Session> {
  const path = snapshotPath(label);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`Snapshot "${label}" not found (looked in ${path}).`);
    }
    throw err;
  }
  try {
    return SessionSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new SessionCorruptError(path, { cause: err });
  }
}

/**
 * Best-effort fsync of a directory so a `rename` into it is durable across a
 * crash. Silently skipped where the platform disallows opening/syncing a
 * directory (e.g. Windows) — the temp-file fsync + atomic rename still hold.
 */
async function fsyncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync unsupported — not fatal; the rename is still atomic.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Compare-and-swap write: persist `session` only if the on-disk revision still
 * equals `expectedRev`, then bump `rev` to `expectedRev + 1`. Throws
 * `SessionConflictError` if another writer committed first. This is the
 * optimistic-concurrency primitive the co-editing layer (human + agent on one
 * document) builds on. Serialized in-process so two local callers can't both
 * pass the check against the same base — that guarantee is exact in-process.
 * Across OS processes the check and the rename are separate syscalls with no
 * lock, so detection is best-effort: a tight interleaving can still last-writer-
 * win undetected. A real cross-process lock is deferred until multi-process
 * editing is on the roadmap (the shipping surface is single-process).
 */
export async function writeSessionIfUnchanged(
  session: Session,
  expectedRev: number,
): Promise<Session> {
  return runExclusive(async () => {
    const actualRev = await readDiskRev();
    if (actualRev !== expectedRev) {
      throw new SessionConflictError(expectedRev, actualRev);
    }
    const next: Session = { ...session, rev: expectedRev + 1 };
    await writeSession(next);
    return next;
  });
}

/**
 * Serialized, atomic read-modify-write. The `mutator` receives a private,
 * mutable copy of the current session, mutates `entries` (or throws to abort),
 * and returns a value. The store bumps `rev` and atomically persists. If a
 * concurrent CROSS-process write is detected between read and commit, the whole
 * mutation re-runs against the fresh state — so `mutator` must be free of
 * external side effects (do those with the returned value, outside).
 *
 * A throw from `mutator` (e.g. "no op with that id") aborts immediately and
 * propagates — only detected write races trigger a retry. Cross-process race
 * detection is best-effort (same caveat as `writeSessionIfUnchanged`); for the
 * single-process shipping surface (embedded agent + UI requests in one process)
 * `runExclusive` makes this exact.
 *
 * Note: the initial read is strict — a corrupt live session.json throws
 * `SessionCorruptError` here. For recovery that must REPLACE a corrupt file
 * (snapshot-restore) use `overwriteSession`, which does not parse it first.
 */
export async function mutateSession<T>(
  mutator: (session: Session) => T,
): Promise<{ result: T; session: Session }> {
  return runExclusive(async () => {
    for (let attempt = 1; attempt <= MAX_MUTATE_ATTEMPTS; attempt++) {
      const current = await readSession();
      const baseRev = current.rev;
      const working: Session = { version: 1, rev: baseRev, entries: [...current.entries] };

      const result = mutator(working);

      // Re-read the on-disk rev immediately before committing. In-process the
      // chain guarantees it's unchanged; a mismatch means another process wrote.
      const diskRev = await readDiskRev();
      if (diskRev !== baseRev) {
        if (attempt === MAX_MUTATE_ATTEMPTS) {
          throw new SessionConflictError(baseRev, diskRev);
        }
        continue;
      }

      working.rev = baseRev + 1;
      await writeSession(working);
      return { result, session: working };
    }
    // Unreachable: the loop either returns or throws on the final attempt.
    throw new SessionConflictError(-1, -1);
  });
}

/** Read just the revision counter; a missing file reads as rev 0. Corrupt files
 *  still surface via `readSession`. */
async function readDiskRev(): Promise<number> {
  return (await readSession()).rev;
}

/**
 * Deliberately replace the entire session with `entries`, atomically and
 * WITHOUT trusting the current on-disk file to be parseable. This is the
 * recovery primitive: snapshot-restore must succeed precisely when the live
 * session.json is the corrupt file being recovered from, so it must not route
 * through `mutateSession` (whose first act is a strict `readSession`). `rev`
 * advances past the last good revision when one is readable, else restarts at 1.
 */
export async function overwriteSession(entries: SessionEntry[]): Promise<Session> {
  return runExclusive(async () => {
    const baseRev = await readRevTolerant();
    const next: Session = { version: 1, rev: baseRev + 1, entries: [...entries] };
    await writeSession(next);
    return next;
  });
}

/** On-disk rev, treating a corrupt file as rev 0 (a deliberate overwrite is
 *  about to discard it anyway). Non-corruption read errors still propagate. */
async function readRevTolerant(): Promise<number> {
  try {
    return (await readSession()).rev;
  } catch (err) {
    if (err instanceof SessionCorruptError) return 0;
    throw err;
  }
}

export function makeEntryId(): string {
  return `op_${randomBytes(4).toString('hex')}`;
}

export async function appendOp(
  entry: Omit<SessionEntry, 'id' | 'timestamp'>,
): Promise<SessionEntry> {
  const full: SessionEntry = {
    id: makeEntryId(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const { result } = await mutateSession((session) => {
    session.entries.push(full);
    return full;
  });
  return result;
}
