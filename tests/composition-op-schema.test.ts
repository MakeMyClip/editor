import { describe, expect, it } from 'vitest';
import {
  type CompositionOp,
  type CompositionOpKind,
  CompositionOpSchema,
  mediaClip,
  videoTrack,
} from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;

// One valid sample per op kind. The `Record<CompositionOpKind, ...>` type makes
// this exhaustive at COMPILE time: add a new op kind and this map fails to type
// until a sample exists, which the parse test below then exercises — so the
// runtime schema can never silently fall behind the hand-written union.
const SAMPLES: Record<CompositionOpKind, CompositionOp> = {
  setCanvas: { op: 'setCanvas', width: 1280, height: 720, fps: 24, background: 'white' },
  addTrack: { op: 'addTrack', track: videoTrack({ id: 'v0' }), index: 1 },
  removeTrack: { op: 'removeTrack', trackId: 'v0' },
  addClip: {
    op: 'addClip',
    trackId: 'v0',
    clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 4, startSec: 0 }),
  },
  removeClip: { op: 'removeClip', clipId: 'c1' },
  moveClip: { op: 'moveClip', clipId: 'c1', startSec: 2, toTrackId: 'v1' },
  setTrim: { op: 'setTrim', clipId: 'c1', sourceInSec: 1, sourceOutSec: 3 },
  setDuration: { op: 'setDuration', clipId: 't1', durationSec: 5 },
  splitClip: { op: 'splitClip', clipId: 'c1', atSec: 2, newClipId: 'c1b' },
  addEffect: { op: 'addEffect', clipId: 'c1', effect: { type: 'speed', factor: 2 }, index: 0 },
  removeEffect: { op: 'removeEffect', clipId: 'c1', index: 0 },
  setTransform: { op: 'setTransform', clipId: 'c1', transform: { scale: 2, x: 0.25 } },
  clearTransform: { op: 'clearTransform', clipId: 'c1' },
  addTransition: {
    op: 'addTransition',
    trackId: 'v0',
    transition: { afterClipId: 'c1', kind: 'fade', durationSec: 1 },
  },
  removeTransition: { op: 'removeTransition', trackId: 'v0', afterClipId: 'c1' },
};

describe('CompositionOpSchema', () => {
  it.each(Object.entries(SAMPLES))('accepts a valid %s op byte-stably', (_kind, op) => {
    expect(CompositionOpSchema.parse(op)).toEqual(op);
  });

  it('rejects an unknown op kind', () => {
    expect(() => CompositionOpSchema.parse({ op: 'teleport', clipId: 'c1' })).toThrow();
  });

  it('rejects a known op missing a required field', () => {
    expect(() => CompositionOpSchema.parse({ op: 'removeClip' })).toThrow();
  });

  it('rejects an op with a malformed nested payload', () => {
    expect(() =>
      CompositionOpSchema.parse({
        op: 'addClip',
        trackId: 'v0',
        clip: { kind: 'media', id: 'c1', mediaId: 'not-a-media-id', sourceOutSec: 4, startSec: 0 },
      }),
    ).toThrow();
  });
});
