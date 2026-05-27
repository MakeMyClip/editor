import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureWorkspace, getWorkspace } from '../workspace.js';
import { type Session, type SessionEntry, SessionSchema } from './types.js';

const SESSION_FILE = 'session.json';

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
 * A fresh empty session. NOT a shared singleton — every caller gets their own
 * `entries` array. We had a bug where `readSession`'s fallback spread the
 * module-level EMPTY_SESSION, and `appendOp`'s `session.entries.push(...)`
 * mutated that singleton's array. The next test (or process call) saw the
 * leaked entries. Always hand out a new object.
 */
function freshEmpty(): Session {
  return { version: 1, entries: [] };
}

export async function readSession(): Promise<Session> {
  await ensureWorkspace();
  try {
    const raw = await readFile(sessionPath(), 'utf-8');
    return SessionSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    // Missing or unparseable session file → start fresh. We deliberately
    // don't surface the error: a fresh workspace has no session yet, and
    // a corrupt session shouldn't block forward progress.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return freshEmpty();
    }
    return freshEmpty();
  }
}

export async function writeSession(session: Session): Promise<void> {
  await ensureWorkspace();
  await writeFile(sessionPath(), `${JSON.stringify(session, null, 2)}\n`);
}

export function makeEntryId(): string {
  return `op_${randomBytes(4).toString('hex')}`;
}

export async function appendOp(
  entry: Omit<SessionEntry, 'id' | 'timestamp'>,
): Promise<SessionEntry> {
  const session = await readSession();
  const full: SessionEntry = {
    id: makeEntryId(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  session.entries.push(full);
  await writeSession(session);
  return full;
}
