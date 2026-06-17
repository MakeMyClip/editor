import { describe, expect, it } from 'vitest';
import { type Composition, emptyComposition } from '../src/timeline/composition.js';
import {
  applyOp,
  applyOps,
  audioTrack,
  type CompositionOp,
  invertOp,
  mediaClip,
  textClip,
  videoTrack,
} from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;

/**
 * A document exercising the cases inverses must handle: a MIDDLE track (z-order),
 * two media clips and a text clip, and a transition after the first clip.
 */
function richDoc(): Composition {
  return applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
    { op: 'addTrack', track: audioTrack({ id: 'a0' }) },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 5, startSec: 0 }),
    },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c2', mediaId: M, sourceOutSec: 4, startSec: 5 }),
    },
    {
      op: 'addClip',
      trackId: 'v1',
      clip: textClip({ id: 't1', text: 'hi', durationSec: 3, startSec: 0 }),
    },
    {
      op: 'addTransition',
      trackId: 'v0',
      transition: { afterClipId: 'c1', kind: 'fade', durationSec: 1 },
    },
  ]);
}

/** The core property: applying an op then its inverse restores the pre-state exactly. */
function expectRoundtrip(pre: Composition, op: CompositionOp): void {
  const frozen = structuredClone(pre);
  const after = applyOp(pre, op);
  const inverse = invertOp(pre, op);
  // invertOp must not mutate its input.
  expect(pre).toEqual(frozen);
  expect(applyOps(after, inverse)).toEqual(pre);
}

describe('invertOp — per-op round-trip (apply then inverse = identity)', () => {
  it('setCanvas (only overwritten fields restored)', () => {
    expectRoundtrip(richDoc(), { op: 'setCanvas', width: 1080, fps: 24 });
  });

  it('addTrack (append) → removeTrack', () => {
    expectRoundtrip(richDoc(), { op: 'addTrack', track: videoTrack({ id: 'vNew' }) });
  });

  it('addTrack (at index) → removeTrack', () => {
    expectRoundtrip(richDoc(), { op: 'addTrack', track: videoTrack({ id: 'vNew' }), index: 1 });
  });

  it('removeTrack of a MIDDLE track restores it at its original z-index', () => {
    expectRoundtrip(richDoc(), { op: 'removeTrack', trackId: 'v1' });
  });

  it('removeTrack of a track carrying clips + a transition', () => {
    expectRoundtrip(richDoc(), { op: 'removeTrack', trackId: 'v0' });
  });

  it('addClip → removeClip', () => {
    expectRoundtrip(richDoc(), {
      op: 'addClip',
      trackId: 'v1',
      clip: mediaClip({ id: 'cNew', mediaId: M, sourceOutSec: 2, startSec: 8 }),
    });
  });

  it('removeClip WITH a following transition restores both', () => {
    expectRoundtrip(richDoc(), { op: 'removeClip', clipId: 'c1' });
  });

  it('removeClip without a transition', () => {
    expectRoundtrip(richDoc(), { op: 'removeClip', clipId: 'c2' });
  });

  it('moveClip (same track, startSec only)', () => {
    expectRoundtrip(richDoc(), { op: 'moveClip', clipId: 'c2', startSec: 7 });
  });

  it('moveClip across tracks (drops + restores the source transition)', () => {
    expectRoundtrip(richDoc(), { op: 'moveClip', clipId: 'c1', toTrackId: 'v1' });
  });

  it('moveClip across tracks AND startSec', () => {
    expectRoundtrip(richDoc(), { op: 'moveClip', clipId: 'c2', startSec: 1, toTrackId: 'v1' });
  });

  it('setTrim', () => {
    expectRoundtrip(richDoc(), { op: 'setTrim', clipId: 'c1', sourceInSec: 1, sourceOutSec: 4 });
  });

  it('setDuration (text clip)', () => {
    expectRoundtrip(richDoc(), { op: 'setDuration', clipId: 't1', durationSec: 6 });
  });

  it('splitClip (media) WITH a following transition', () => {
    expectRoundtrip(richDoc(), { op: 'splitClip', clipId: 'c1', atSec: 2, newClipId: 'c1b' });
  });

  it('splitClip (media) without a transition', () => {
    expectRoundtrip(richDoc(), { op: 'splitClip', clipId: 'c2', atSec: 6, newClipId: 'c2b' });
  });

  it('splitClip (text)', () => {
    expectRoundtrip(richDoc(), { op: 'splitClip', clipId: 't1', atSec: 1, newClipId: 't1b' });
  });

  it('addEffect (append)', () => {
    expectRoundtrip(richDoc(), {
      op: 'addEffect',
      clipId: 'c1',
      effect: { type: 'speed', factor: 2 },
    });
  });

  it('addEffect (at index, among existing effects)', () => {
    const pre = applyOps(richDoc(), [
      { op: 'addEffect', clipId: 'c1', effect: { type: 'speed', factor: 2 } },
      { op: 'addEffect', clipId: 'c1', effect: { type: 'volume', gain: 0.5 } },
    ]);
    expectRoundtrip(pre, {
      op: 'addEffect',
      clipId: 'c1',
      effect: { type: 'fadeIn', durationSec: 1 },
      index: 1,
    });
  });

  it('removeEffect', () => {
    const pre = applyOps(richDoc(), [
      { op: 'addEffect', clipId: 'c1', effect: { type: 'speed', factor: 2 } },
      { op: 'addEffect', clipId: 'c1', effect: { type: 'volume', gain: 0.5 } },
    ]);
    expectRoundtrip(pre, { op: 'removeEffect', clipId: 'c1', index: 0 });
  });

  it('setTransform on a clip with NO prior transform (inverse clears)', () => {
    expectRoundtrip(richDoc(), { op: 'setTransform', clipId: 'c1', transform: { scale: 2 } });
  });

  it('setTransform on a clip WITH a prior transform (inverse restores it)', () => {
    const pre = applyOp(richDoc(), {
      op: 'setTransform',
      clipId: 'c1',
      transform: { scale: 2, x: 0.25 },
    });
    expectRoundtrip(pre, {
      op: 'setTransform',
      clipId: 'c1',
      transform: { x: 0.75, opacity: 0.5 },
    });
  });

  it('clearTransform on a clip with a transform (inverse restores it)', () => {
    const pre = applyOp(richDoc(), { op: 'setTransform', clipId: 'c1', transform: { scale: 3 } });
    expectRoundtrip(pre, { op: 'clearTransform', clipId: 'c1' });
  });

  it('clearTransform on a clip with no transform (no-op round-trip)', () => {
    expectRoundtrip(richDoc(), { op: 'clearTransform', clipId: 'c1' });
  });

  it('addTransition (fresh)', () => {
    expectRoundtrip(richDoc(), {
      op: 'addTransition',
      trackId: 'v0',
      transition: { afterClipId: 'c2', kind: 'wipeleft', durationSec: 0.5 },
    });
  });

  it('addTransition REPLACING an existing one restores the prior', () => {
    expectRoundtrip(richDoc(), {
      op: 'addTransition',
      trackId: 'v0',
      transition: { afterClipId: 'c1', kind: 'circleopen', durationSec: 2 },
    });
  });

  it('removeTransition (existing)', () => {
    expectRoundtrip(richDoc(), { op: 'removeTransition', trackId: 'v0', afterClipId: 'c1' });
  });

  it('removeTransition (nonexistent — no-op round-trip)', () => {
    expectRoundtrip(richDoc(), { op: 'removeTransition', trackId: 'v0', afterClipId: 'c2' });
  });
});

describe('invertOp — LIFO sequence undo (mirrors the op-log undo path)', () => {
  it('undoing a sequence of ops in reverse restores the start state', () => {
    const start = richDoc();
    const ops: CompositionOp[] = [
      { op: 'setTransform', clipId: 'c1', transform: { scale: 2 } },
      { op: 'splitClip', clipId: 'c1', atSec: 2, newClipId: 'c1b' },
      { op: 'moveClip', clipId: 't1', toTrackId: 'v0' },
      { op: 'addEffect', clipId: 'c2', effect: { type: 'fadeOut', durationSec: 1 } },
      { op: 'removeTrack', trackId: 'a0' },
    ];

    // Apply forward, capturing each op's inverse against the state it saw.
    let state = start;
    const inverses: CompositionOp[][] = [];
    for (const op of ops) {
      inverses.push(invertOp(state, op));
      state = applyOp(state, op);
    }

    // Undo in reverse (LIFO), exactly as popping op-log entries would.
    let undone = state;
    for (let i = inverses.length - 1; i >= 0; i--) {
      const inv = inverses[i];
      if (inv) undone = applyOps(undone, inv);
    }

    expect(undone).toEqual(start);
  });
});

describe('new op-vocabulary arms', () => {
  it('addTrack with index inserts at the z-order position', () => {
    const comp = applyOp(richDoc(), { op: 'addTrack', track: videoTrack({ id: 'vX' }), index: 1 });
    expect(comp.tracks.map((t) => t.id)).toEqual(['v0', 'vX', 'v1', 'a0']);
  });

  it('addTrack index clamps out-of-range values', () => {
    const comp = applyOp(richDoc(), { op: 'addTrack', track: videoTrack({ id: 'vX' }), index: 99 });
    expect(comp.tracks.map((t) => t.id)).toEqual(['v0', 'v1', 'a0', 'vX']);
  });

  it('clearTransform removes the transform field', () => {
    const withTransform = applyOp(richDoc(), {
      op: 'setTransform',
      clipId: 'c1',
      transform: { scale: 2 },
    });
    const cleared = applyOp(withTransform, { op: 'clearTransform', clipId: 'c1' });
    const clip = cleared.tracks[0]?.clips.find((c) => c.id === 'c1');
    expect(clip?.transform).toBeUndefined();
  });

  it('clearTransform throws on a missing clip', () => {
    expect(() => applyOp(richDoc(), { op: 'clearTransform', clipId: 'nope' })).toThrow();
  });
});

describe('invertOp — clips carrying effects + a transform (no silent data loss)', () => {
  // A clip with a transform and a non-trivial effect stack is where a sloppy
  // inverse would quietly drop data; structuredClone + deep-equal must catch it.
  function decoratedDoc(): Composition {
    return applyOps(richDoc(), [
      { op: 'setTransform', clipId: 'c1', transform: { scale: 1.5, x: 0.4, opacity: 0.8 } },
      { op: 'addEffect', clipId: 'c1', effect: { type: 'speed', factor: 1.5 } },
      { op: 'addEffect', clipId: 'c1', effect: { type: 'fadeIn', durationSec: 0.5 } },
    ]);
  }

  it('splitClip preserves effects + transform on both halves through the round-trip', () => {
    expectRoundtrip(decoratedDoc(), { op: 'splitClip', clipId: 'c1', atSec: 2, newClipId: 'c1b' });
  });

  it('moveClip across tracks preserves effects + transform + the dropped transition', () => {
    expectRoundtrip(decoratedDoc(), { op: 'moveClip', clipId: 'c1', toTrackId: 'v1' });
  });

  it('removeTrack restores a track whose clips carry effects + transforms', () => {
    expectRoundtrip(decoratedDoc(), { op: 'removeTrack', trackId: 'v0' });
  });
});

describe('invertOp — array-order edge cases (regressions)', () => {
  // A track carrying MORE THAN ONE transition, where the one we disturb is not
  // last in the array. A non-canonical inverse would re-append it and fail the
  // deep-equal round-trip.
  function multiTransitionDoc(): Composition {
    return applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 4, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c2', mediaId: M, sourceOutSec: 4, startSec: 4 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c3', mediaId: M, sourceOutSec: 4, startSec: 8 }),
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'c1', kind: 'fade', durationSec: 1 },
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'c2', kind: 'wipeleft', durationSec: 1 },
      },
    ]);
  }

  it('removeClip of a clip whose transition is NOT last in the array', () => {
    expectRoundtrip(multiTransitionDoc(), { op: 'removeClip', clipId: 'c1' });
  });

  it('moveClip (cross-track) of a clip whose transition is not last', () => {
    expectRoundtrip(multiTransitionDoc(), { op: 'moveClip', clipId: 'c1', toTrackId: 'v1' });
  });

  it('splitClip of a clip whose transition is not last', () => {
    expectRoundtrip(multiTransitionDoc(), {
      op: 'splitClip',
      clipId: 'c1',
      atSec: 2,
      newClipId: 'c1b',
    });
  });

  it('addTransition replacing one that is not last', () => {
    expectRoundtrip(multiTransitionDoc(), {
      op: 'addTransition',
      trackId: 'v0',
      transition: { afterClipId: 'c1', kind: 'circleopen', durationSec: 2 },
    });
  });

  // Two clips sharing a startSec on one track — a startSec-only sort would flip
  // their relative order when one is removed and re-added.
  function equalStartDoc(): Composition {
    return applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'ca', mediaId: M, sourceOutSec: 3, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'cb', mediaId: M, sourceOutSec: 3, startSec: 0 }),
      },
    ]);
  }

  it('removeClip of one of two equal-startSec siblings', () => {
    expectRoundtrip(equalStartDoc(), { op: 'removeClip', clipId: 'ca' });
  });

  it('moveClip (cross-track) of one of two equal-startSec siblings', () => {
    expectRoundtrip(equalStartDoc(), { op: 'moveClip', clipId: 'ca', toTrackId: 'v1' });
  });
});
