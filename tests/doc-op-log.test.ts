import { describe, expect, it } from 'vitest';
import { emptyComposition } from '../src/timeline/composition.js';
import {
  canRedo,
  canUndo,
  type DocOpLogEntry,
  emptyDocOpLog,
  parseDocOpLog,
  reconcile,
  recordOps,
  redo,
  serializeDocOpLog,
  undo,
} from '../src/timeline/doc-op-log.js';
import {
  applyOps,
  applyOpsTracked,
  type CompositionOp,
  mediaClip,
  videoTrack,
} from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;

function entry(id: string, forward: CompositionOp[], inverse: CompositionOp[]): DocOpLogEntry {
  return { id, label: forward.map((o) => o.op).join('+'), forward, inverse };
}

describe('applyOpsTracked', () => {
  it('matches applyOps forward and returns an inverse that undoes the whole batch', () => {
    const start = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    ]);
    const ops: CompositionOp[] = [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 4, startSec: 0 }),
      },
      { op: 'splitClip', clipId: 'c1', atSec: 2, newClipId: 'c1b' },
      { op: 'setTransform', clipId: 'c1', transform: { scale: 2 } },
    ];
    const { doc, inverse } = applyOpsTracked(start, ops);
    expect(doc).toEqual(applyOps(start, ops)); // same forward result
    expect(applyOps(doc, inverse)).toEqual(start); // inverse undoes the batch
  });

  it('an empty batch is a no-op with an empty inverse', () => {
    const start = emptyComposition();
    const { doc, inverse } = applyOpsTracked(start, []);
    expect(doc).toEqual(start);
    expect(inverse).toEqual([]);
  });
});

describe('doc-op-log algebra', () => {
  it('recordOps appends entries and advances the cursor', () => {
    let log = emptyDocOpLog(0);
    log = recordOps(
      log,
      entry('dop_1', [{ op: 'setCanvas', width: 1 }], [{ op: 'setCanvas', width: 2 }]),
    );
    log = recordOps(
      log,
      entry('dop_2', [{ op: 'setCanvas', width: 3 }], [{ op: 'setCanvas', width: 1 }]),
    );
    expect(log.entries.map((e) => e.id)).toEqual(['dop_1', 'dop_2']);
    expect(log.cursor).toBe(2);
    expect(canUndo(log)).toBe(true);
    expect(canRedo(log)).toBe(false);
  });

  it('undo moves the cursor back and returns the entry to reverse', () => {
    let log = emptyDocOpLog();
    log = recordOps(
      log,
      entry('dop_1', [{ op: 'setCanvas', width: 1 }], [{ op: 'setCanvas', width: 9 }]),
    );
    const u = undo(log);
    expect(u?.entry.id).toBe('dop_1');
    expect(u?.log.cursor).toBe(0);
    expect(canRedo(u?.log ?? log)).toBe(true);
  });

  it('redo returns the forward entry and restores the cursor', () => {
    let log = emptyDocOpLog();
    log = recordOps(
      log,
      entry('dop_1', [{ op: 'setCanvas', width: 1 }], [{ op: 'setCanvas', width: 9 }]),
    );
    const afterUndo = undo(log)?.log ?? log;
    const r = redo(afterUndo);
    expect(r?.entry.id).toBe('dop_1');
    expect(r?.log.cursor).toBe(1);
  });

  it('undo at the bottom and redo at the top return null', () => {
    expect(undo(emptyDocOpLog())).toBeNull();
    const log = recordOps(emptyDocOpLog(), entry('dop_1', [], []));
    expect(redo(log)).toBeNull(); // cursor already at the end
  });

  it('a fresh edit after undo truncates the redo tail', () => {
    let log = emptyDocOpLog();
    log = recordOps(log, entry('a', [{ op: 'setCanvas', width: 1 }], []));
    log = recordOps(log, entry('b', [{ op: 'setCanvas', width: 2 }], []));
    log = undo(log)?.log ?? log; // cursor 1; 'b' is now redoable
    log = recordOps(log, entry('c', [{ op: 'setCanvas', width: 3 }], [])); // truncates 'b'
    expect(log.entries.map((e) => e.id)).toEqual(['a', 'c']);
    expect(log.cursor).toBe(2);
    expect(canRedo(log)).toBe(false);
  });
});

describe('reconcile (crash-desync safety)', () => {
  it('trusts the log when the revs match', () => {
    const log = recordOps(emptyDocOpLog(5), entry('dop_1', [], []));
    expect(reconcile(log, 5)).toBe(log);
  });

  it('drops history (keeps an empty log at the doc rev) when revs disagree', () => {
    const log = recordOps(emptyDocOpLog(5), entry('dop_1', [], []));
    const r = reconcile(log, 6);
    expect(r.entries).toEqual([]);
    expect(r.cursor).toBe(0);
    expect(r.rev).toBe(6);
  });
});

describe('persistence (parse / serialize)', () => {
  it('round-trips through serialize + parse', () => {
    const log = recordOps(
      emptyDocOpLog(3),
      entry(
        'dop_1',
        [
          {
            op: 'addClip',
            trackId: 'v0',
            clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 4, startSec: 0 }),
          },
        ],
        [{ op: 'removeClip', clipId: 'c1' }],
      ),
    );
    expect(parseDocOpLog(JSON.parse(serializeDocOpLog(log)))).toEqual(log);
  });

  it('loads a rev-less / cursor-less legacy log with defaults', () => {
    expect(parseDocOpLog({ version: 1, entries: [] })).toEqual({
      version: 1,
      rev: 0,
      cursor: 0,
      entries: [],
    });
  });

  it('rejects a log carrying a malformed op', () => {
    expect(() =>
      parseDocOpLog({
        version: 1,
        rev: 0,
        cursor: 0,
        entries: [{ id: 'x', label: 'bad', forward: [{ op: 'nope' }], inverse: [] }],
      }),
    ).toThrow();
  });
});
