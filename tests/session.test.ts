import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendOp,
  makeEntryId,
  readSession,
  sessionPath,
  snapshotPath,
  snapshotsDir,
  writeSession,
} from '../src/session/store.js';
import { EMPTY_SESSION, SessionEntrySchema } from '../src/session/types.js';

let workspace: string;
let savedWorkspace: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-session-test-'));
  savedWorkspace = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (savedWorkspace === undefined) {
    delete process.env.MAKEMYCLIP_WORKSPACE;
  } else {
    process.env.MAKEMYCLIP_WORKSPACE = savedWorkspace;
  }
  await rm(workspace, { recursive: true, force: true });
});

describe('makeEntryId', () => {
  it('produces op_<8 hex chars>', () => {
    const id = makeEntryId();
    expect(id).toMatch(/^op_[a-f0-9]{8}$/);
  });

  it('is uniquish across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeEntryId()));
    expect(ids.size).toBe(50);
  });
});

describe('readSession', () => {
  it('returns EMPTY_SESSION when no file exists', async () => {
    const session = await readSession();
    expect(session).toEqual(EMPTY_SESSION);
  });

  it('reads and validates an existing session file', async () => {
    const initial = { version: 1, entries: [] };
    await writeFile(sessionPath(), JSON.stringify(initial));
    const session = await readSession();
    expect(session).toEqual(initial);
  });

  it('falls back to EMPTY_SESSION when file is corrupt', async () => {
    await writeFile(sessionPath(), 'not valid json');
    const session = await readSession();
    expect(session).toEqual(EMPTY_SESSION);
  });
});

describe('appendOp', () => {
  it('adds a new entry with id + timestamp', async () => {
    const entry = await appendOp({
      tool: 'trim',
      args: { input: 'a.mp4', start: '0', end: '1' },
      result: { path: '/tmp/out.mp4' },
    });
    expect(entry.id).toMatch(/^op_[a-f0-9]{8}$/);
    expect(typeof entry.timestamp).toBe('string');
    expect(() => SessionEntrySchema.parse(entry)).not.toThrow();
  });

  it('persists across calls', async () => {
    await appendOp({ tool: 'trim', args: {}, result: {} });
    await appendOp({ tool: 'concat', args: {}, result: {} });
    const session = await readSession();
    expect(session.entries.length).toBe(2);
    expect(session.entries[0]?.tool).toBe('trim');
    expect(session.entries[1]?.tool).toBe('concat');
  });
});

describe('snapshot paths', () => {
  it('snapshotsDir lives under the workspace', () => {
    expect(snapshotsDir()).toBe(join(workspace, 'snapshots'));
  });

  it('snapshotPath uses the label as filename', () => {
    expect(snapshotPath('my-label')).toBe(join(workspace, 'snapshots', 'my-label.json'));
  });
});

describe('writeSession + readSession round-trip', () => {
  it('preserves entries', async () => {
    const session = await appendOp({
      tool: 'ingest',
      args: { path: 'a.mp4' },
      result: { mediaId: 'm_abc123' },
    }).then(() => readSession());

    await writeSession(session);
    const reread = await readSession();
    expect(reread).toEqual(session);
  });

  it('snapshots directory is created on demand', async () => {
    await mkdir(snapshotsDir(), { recursive: true });
    // Should not throw on second mkdir.
    await mkdir(snapshotsDir(), { recursive: true });
  });
});
