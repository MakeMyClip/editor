import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyComposition } from '../src/timeline/composition.js';
import {
  compositionOpsPath,
  compositionPath,
  mutateComposition,
  overwriteComposition,
  readComposition,
  readDocOpLog,
  redoDocOp,
  resetComposition,
  undoLastDocOp,
  writeCompositionIfUnchanged,
} from '../src/timeline/document-store.js';
import { mediaClip, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-oplog-test-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

describe('op-log integration — undo / redo', () => {
  it('records each mutation and exposes undo/redo state', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    const log = await readDocOpLog();
    expect(log.entries).toHaveLength(1);
    expect(log.cursor).toBe(1);
    expect(log.entries[0]?.label).toBe('addTrack');
  });

  it('undo reverts the document and redo re-applies it', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    const before = await readComposition();

    expect((await undoLastDocOp()).undone).toBe(true);
    expect((await readComposition()).tracks).toEqual([]);

    expect((await redoDocOp()).redone).toBe(true);
    const after = await readComposition();
    expect(after.tracks.map((t) => t.id)).toEqual(['v0']);
    // Same content as before the undo (rev advances — undo/redo are writes).
    expect({ ...after, rev: 0 }).toEqual({ ...before, rev: 0 });
  });

  it('undo at the bottom and redo at the top are no-ops', async () => {
    expect((await undoLastDocOp()).undone).toBe(false);
    await mutateComposition([{ op: 'setCanvas', width: 1280 }]);
    expect((await redoDocOp()).redone).toBe(false);
  });

  it('a fresh edit after undo truncates the redo tail', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v1' }) }]);
    await undoLastDocOp(); // undo v1; it is now redoable
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v2' }) }]); // truncates v1

    const log = await readDocOpLog();
    expect(log.entries.map((e) => e.label)).toEqual(['addTrack', 'addTrack']);
    expect(log.cursor).toBe(2);
    expect((await redoDocOp()).redone).toBe(false);
    expect((await readComposition()).tracks.map((t) => t.id)).toEqual(['v0', 'v2']);
  });

  it('doc rev and log rev stay in lockstep across mutate / undo / redo', async () => {
    await mutateComposition([{ op: 'setCanvas', width: 1280 }]);
    expect((await readDocOpLog()).rev).toBe((await readComposition()).rev);
    await mutateComposition([{ op: 'setCanvas', height: 720 }]);
    expect((await readDocOpLog()).rev).toBe((await readComposition()).rev);
    await undoLastDocOp();
    expect((await readDocOpLog()).rev).toBe((await readComposition()).rev);
    await redoDocOp();
    expect((await readDocOpLog()).rev).toBe((await readComposition()).rev);
  });

  it('multi-step undo then redo returns to the exact prior state', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    await mutateComposition([
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 4, startSec: 0 }),
      },
    ]);
    const final = await readComposition();

    await undoLastDocOp();
    await undoLastDocOp();
    expect((await readComposition()).tracks).toEqual([]);

    await redoDocOp();
    await redoDocOp();
    expect({ ...(await readComposition()), rev: 0 }).toEqual({ ...final, rev: 0 });
  });

  it('drops undo history when the op-log file is corrupt — the document survives', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    await writeFile(compositionOpsPath(), 'not valid json');

    const log = await readDocOpLog();
    expect(log.entries).toEqual([]); // history dropped, no throw
    expect((await readComposition()).tracks.map((t) => t.id)).toEqual(['v0']); // doc intact
    expect((await undoLastDocOp()).undone).toBe(false);
  });

  it('resetComposition (clip timeline new) clears the op-log', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    await resetComposition(emptyComposition());
    expect((await readDocOpLog()).entries).toEqual([]);
    expect((await undoLastDocOp()).undone).toBe(false);
  });

  it('an empty op batch is a true no-op (no rev bump, no log entry)', async () => {
    await mutateComposition([{ op: 'setCanvas', width: 1280 }]); // rev 1
    const before = await readComposition();
    await mutateComposition([]);
    expect((await readComposition()).rev).toBe(before.rev);
    expect((await readDocOpLog()).entries).toHaveLength(1);
  });
});

describe('op-log lockstep across non-recording doc writers (regressions)', () => {
  it('overwriteComposition over a corrupt doc resets history — undo does NOT replay a stale inverse', async () => {
    // The colliding-rev case: mutate once (doc rev 1, log rev 1 with an addTrack
    // entry), corrupt the doc, then recover. A naive overwrite resets the doc to
    // rev 1 while leaving the log at rev 1, so reconcile MATCHES the stale log and
    // undo applies removeTrack to a doc with no such track — which throws.
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    await writeFile(compositionPath(), 'not valid json');
    await overwriteComposition(emptyComposition());

    const log = await readDocOpLog();
    expect(log.entries).toEqual([]);
    expect(log.rev).toBe((await readComposition()).rev); // lockstep
    expect((await undoLastDocOp()).undone).toBe(false); // a clean no-op, not a throw
  });

  it('writeCompositionIfUnchanged resets undo history and keeps revs in lockstep', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v1' }) }]);
    const current = await readComposition();

    await writeCompositionIfUnchanged({ ...current, background: '#111' }, current.rev);

    const log = await readDocOpLog();
    expect(log.entries).toEqual([]); // a raw CAS write is not recorded → history reset
    expect(log.rev).toBe((await readComposition()).rev); // lockstep, not a silent desync
    expect((await undoLastDocOp()).undone).toBe(false);
  });

  it('resetComposition advances rev past the previous one (never reuses a rev)', async () => {
    await mutateComposition([{ op: 'setCanvas', width: 1280 }]); // rev 1
    await mutateComposition([{ op: 'setCanvas', height: 720 }]); // rev 2
    const reset = await resetComposition(emptyComposition());
    expect(reset.rev).toBeGreaterThan(2);
    expect((await readComposition()).rev).toBe(reset.rev);
    expect((await readDocOpLog()).rev).toBe(reset.rev);
  });
});
