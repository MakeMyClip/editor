import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendOp, readSession } from '../src/session/store.js';
import { DeleteOpInput, deleteOp } from '../src/tools/delete-op.js';
import { inspect } from '../src/tools/inspect.js';
import { snapshot } from '../src/tools/snapshot.js';
import { undo } from '../src/tools/undo.js';

let workspace: string;
let savedWorkspace: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-safety-test-'));
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

describe('snapshot', () => {
  it('writes the current session JSON to snapshots/<label>.json', async () => {
    await appendOp({ tool: 'trim', args: {}, result: {} });
    const result = await snapshot({ label: 'first' });
    expect(result.label).toBe('first');
    expect(result.entryCount).toBe(1);
    expect(result.path.endsWith('first.json')).toBe(true);
  });

  it('auto-labels as snap-<N> when no label given', async () => {
    await appendOp({ tool: 'trim', args: {}, result: {} });
    await appendOp({ tool: 'concat', args: {}, result: {} });
    const result = await snapshot({});
    expect(result.label).toBe('snap-2');
  });

  it('snapshot of empty session works', async () => {
    const result = await snapshot({ label: 'empty' });
    expect(result.entryCount).toBe(0);
  });
});

describe('undo', () => {
  it('pops the last entry by default', async () => {
    await appendOp({ tool: 'a', args: {}, result: {} });
    const second = await appendOp({ tool: 'b', args: {}, result: {} });
    const result = await undo({});
    expect(result.removedOpId).toBe(second.id);
    expect(result.entryCount).toBe(1);
  });

  it('throws when session is empty', async () => {
    await expect(undo({})).rejects.toThrow(/empty/i);
  });

  it('restores from a snapshot', async () => {
    await appendOp({ tool: 'a', args: {}, result: {} });
    await snapshot({ label: 'one-op' });
    await appendOp({ tool: 'b', args: {}, result: {} });
    await appendOp({ tool: 'c', args: {}, result: {} });
    expect((await readSession()).entries.length).toBe(3);

    const result = await undo({ snapshotLabel: 'one-op' });
    expect(result.restoredFrom).toBe('one-op');
    expect(result.entryCount).toBe(1);
    expect((await readSession()).entries.length).toBe(1);
  });
});

describe('inspect', () => {
  it('returns totalOps and entry summaries', async () => {
    await appendOp({ tool: 'trim', args: { input: 'a.mp4', start: '1', end: '5' }, result: {} });
    await appendOp({ tool: 'add_text', args: { text: 'Hi', startSec: 0, endSec: 2 }, result: {} });
    const result = await inspect({});
    expect(result.totalOps).toBe(2);
    expect(result.entries.length).toBe(2);
    expect(result.entries[0]?.summary).toContain('trim');
    expect(result.entries[1]?.summary).toContain('add_text');
  });

  it('honors limit', async () => {
    for (let i = 0; i < 5; i++) {
      await appendOp({ tool: `t${i}`, args: {}, result: {} });
    }
    const result = await inspect({ limit: 2 });
    expect(result.totalOps).toBe(5);
    expect(result.entries.length).toBe(2);
    // Last two ops only.
    expect(result.entries[0]?.tool).toBe('t3');
    expect(result.entries[1]?.tool).toBe('t4');
  });
});

describe('deleteOp', () => {
  it('removes the op from the session log', async () => {
    const a = await appendOp({ tool: 'trim', args: {}, result: { path: '/tmp/a.mp4' } });
    await appendOp({ tool: 'concat', args: {}, result: {} });
    const result = await deleteOp({ id: a.id });
    expect(result.removedOpId).toBe(a.id);
    expect(result.entryCount).toBe(1);
    expect((await readSession()).entries.find((e) => e.id === a.id)).toBeUndefined();
  });

  it('throws on unknown id', async () => {
    await expect(deleteOp({ id: 'op_deadbeef' })).rejects.toThrow(/No op with id/);
  });
});

describe('DeleteOpInput', () => {
  it('accepts a valid id', () => {
    expect(() => DeleteOpInput.parse({ id: 'op_abcd1234' })).not.toThrow();
  });

  it('rejects malformed ids', () => {
    expect(() => DeleteOpInput.parse({ id: 'wrong' })).toThrow();
    expect(() => DeleteOpInput.parse({ id: 'op_xyz' })).toThrow();
    expect(() => DeleteOpInput.parse({ id: 'op_ABCD1234' })).toThrow();
  });

  it('defaults removeFile to false', () => {
    const parsed = DeleteOpInput.parse({ id: 'op_abcd1234' });
    expect(parsed.removeFile).toBe(false);
  });
});
