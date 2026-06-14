import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendOp,
  makeEntryId,
  overwriteSession,
  readSession,
  SessionConflictError,
  SessionCorruptError,
  sessionPath,
  snapshotPath,
  snapshotsDir,
  writeSession,
  writeSessionIfUnchanged,
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

  it('reads a rev-less legacy file, defaulting rev to 0', async () => {
    // Files written before `rev` existed must still load — back-compat.
    await writeFile(sessionPath(), JSON.stringify({ version: 1, entries: [] }));
    const session = await readSession();
    expect(session).toEqual({ version: 1, rev: 0, entries: [] });
  });

  it('throws SessionCorruptError on unparseable JSON instead of silently resetting', async () => {
    await writeFile(sessionPath(), 'not valid json');
    await expect(readSession()).rejects.toBeInstanceOf(SessionCorruptError);
  });

  it('throws SessionCorruptError on valid JSON that fails the schema', async () => {
    await writeFile(sessionPath(), JSON.stringify({ version: 2, entries: 'nope' }));
    await expect(readSession()).rejects.toBeInstanceOf(SessionCorruptError);
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

describe('single-writer serialization', () => {
  it('does not lose entries under concurrent in-process appends', async () => {
    // The original bug: appendOp was a lock-free read-modify-write, so N
    // concurrent callers (the embedded agent + UI requests) clobbered each
    // other and entries vanished. Serialization must land all of them.
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) => appendOp({ tool: `t${i}`, args: {}, result: {} })),
    );
    const session = await readSession();
    expect(session.entries).toHaveLength(N);
    expect(session.rev).toBe(N);
    // Every distinct tool name made it in — no overwrites.
    expect(new Set(session.entries.map((e) => e.tool)).size).toBe(N);
  });
});

describe('atomic writes', () => {
  it('leaves no temp files behind and keeps session.json intact', async () => {
    await appendOp({ tool: 'a', args: {}, result: {} });
    await appendOp({ tool: 'b', args: {}, result: {} });
    const files = await readdir(workspace);
    expect(files).toContain('session.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
});

describe('optimistic concurrency (rev)', () => {
  it('increments rev monotonically on each append', async () => {
    expect((await readSession()).rev).toBe(0);
    await appendOp({ tool: 'a', args: {}, result: {} });
    expect((await readSession()).rev).toBe(1);
    await appendOp({ tool: 'b', args: {}, result: {} });
    expect((await readSession()).rev).toBe(2);
  });

  it('writeSessionIfUnchanged commits and bumps rev when the base is current', async () => {
    await appendOp({ tool: 'a', args: {}, result: {} });
    const current = await readSession();
    const next = await writeSessionIfUnchanged(current, current.rev);
    expect(next.rev).toBe(current.rev + 1);
    expect((await readSession()).rev).toBe(current.rev + 1);
  });

  it('rejects a stale write whose base rev was superseded, without clobbering', async () => {
    await appendOp({ tool: 'a', args: {}, result: {} });
    const stale = await readSession(); // captured at rev 1
    await appendOp({ tool: 'b', args: {}, result: {} }); // another writer wins → rev 2

    await expect(writeSessionIfUnchanged(stale, stale.rev)).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    // The winner's entry survives; the rejected write did not overwrite it.
    const final = await readSession();
    expect(final.entries.map((e) => e.tool)).toEqual(['a', 'b']);
  });
});

describe('overwriteSession (recovery primitive)', () => {
  it('replaces entries WITHOUT parsing the live file, even when it is corrupt', async () => {
    await appendOp({ tool: 'a', args: {}, result: {} }); // rev 1
    await writeFile(sessionPath(), 'this is not valid json'); // live log now corrupt
    await expect(readSession()).rejects.toBeInstanceOf(SessionCorruptError);

    const entry = {
      id: 'op_12345678',
      tool: 'x',
      args: {},
      result: {},
      timestamp: '1970-01-01T00:00:00.000Z',
    };
    const next = await overwriteSession([entry]);
    expect(next.entries).toHaveLength(1);
    expect(next.rev).toBe(1); // corrupt base → rev 0 → 1

    const reread = await readSession();
    expect(reread.entries.map((e) => e.tool)).toEqual(['x']);
  });
});
