import { describe, expect, it } from 'vitest';
import { type Composition, emptyComposition } from '../src/timeline/composition.js';
import {
  applyOps,
  type CompositionOp,
  CompositionOpError,
  colorClip,
  mediaClip,
  textClip,
  videoTrack,
} from '../src/timeline/ops.js';
import { canvasFor, planFraming, planReframe, ReframeError } from '../src/timeline/reframe.js';
import type { MediaId } from '../src/timeline/schema.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;

/** A 1080p doc: two media clips and a title card on v0, a caption above. */
function doc(extra: CompositionOp[] = [], canvas: Partial<Composition> = {}): Composition {
  return applyOps(emptyComposition(canvas), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    { op: 'addTrack', track: videoTrack({ id: 'captions' }) },
    { op: 'addClip', trackId: 'v0', clip: colorClip({ id: 'card', durationSec: 1, startSec: 0 }) },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'a', mediaId: M, sourceOutSec: 3, startSec: 1 }),
    },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'b', mediaId: M, sourceOutSec: 3, startSec: 4 }),
    },
    {
      op: 'addClip',
      trackId: 'captions',
      clip: textClip({ id: 'cap', text: 'Hi', durationSec: 1, startSec: 1 }),
    },
    ...extra,
  ]);
}

describe('canvasFor', () => {
  it('keeps the short side of a 1080p canvas', () => {
    const comp = emptyComposition();
    expect(canvasFor(comp, '9:16')).toEqual({ width: 1080, height: 1920 });
    expect(canvasFor(comp, '1:1')).toEqual({ width: 1080, height: 1080 });
    expect(canvasFor(comp, '4:5')).toEqual({ width: 1080, height: 1350 });
    expect(canvasFor(comp, '16:9')).toEqual({ width: 1920, height: 1080 });
  });

  it('scales with the canvas and comes back from portrait', () => {
    expect(canvasFor(emptyComposition({ width: 3840, height: 2160 }), '9:16')).toEqual({
      width: 2160,
      height: 3840,
    });
    expect(canvasFor(emptyComposition({ width: 1080, height: 1920 }), '16:9')).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('rounds the long side to an even number of pixels', () => {
    expect(canvasFor(emptyComposition({ width: 854, height: 480 }), '9:16')).toEqual({
      width: 480,
      height: 854,
    });
  });
});

describe('planReframe', () => {
  it('sets the canvas shape and cover fit by default', () => {
    const plan = planReframe(doc(), { aspect: '9:16' });
    expect(plan.ops).toEqual([{ op: 'setCanvas', width: 1080, height: 1920, fit: 'cover' }]);
    expect(plan.canvas).toEqual({ width: 1080, height: 1920, fit: 'cover' });
    expect(plan.clipIds).toEqual([]);
  });

  it('emits only what changes, and nothing when the document already matches', () => {
    expect(planReframe(doc(), { aspect: '16:9', fit: 'contain' }).ops).toEqual([]);
    expect(planReframe(doc(), { aspect: '16:9' }).ops).toEqual([{ op: 'setCanvas', fit: 'cover' }]);
    const portrait = doc([], { width: 1080, height: 1920, fit: 'cover' });
    expect(planReframe(portrait, { aspect: '9:16' }).ops).toEqual([]);
  });

  it('positions every media clip on the picture track, skipping ones already there', () => {
    const plan = planReframe(doc([{ op: 'setTransform', clipId: 'b', transform: { x: 0.3 } }]), {
      aspect: '9:16',
      x: 0.3,
    });
    expect(plan.ops).toEqual([
      { op: 'setCanvas', width: 1080, height: 1920, fit: 'cover' },
      { op: 'setTransform', clipId: 'a', transform: { x: 0.3 } },
    ]);
    expect(plan.clipIds).toEqual(['a']);
  });

  it('takes an exact even size instead of an aspect', () => {
    expect(planReframe(doc(), { width: 720, height: 1280, fit: 'contain' }).ops).toEqual([
      { op: 'setCanvas', width: 720, height: 1280 },
    ]);
  });

  it('positions nothing when there is no single picture track', () => {
    const empty = emptyComposition();
    expect(planReframe(empty, { aspect: '1:1', x: 0 }).clipIds).toEqual([]);
  });

  it('refuses a missing, doubled or odd size and a position outside 0..1', () => {
    expect(() => planReframe(doc(), {})).toThrow(ReframeError);
    expect(() => planReframe(doc(), { width: 1080 })).toThrow(/both a width and a height/);
    expect(() => planReframe(doc(), { aspect: '9:16', width: 1080, height: 1920 })).toThrow(
      /not both/,
    );
    expect(() => planReframe(doc(), { width: 1081, height: 1920 })).toThrow(/even/);
    expect(() => planReframe(doc(), { aspect: '9:16', x: 1.5 })).toThrow(/between 0 and 1/);
  });
});

describe('planFraming', () => {
  it('sets only the fields that change', () => {
    expect(planFraming(doc(), { clipId: 'a', fit: 'cover', scale: 1.3, x: 0.5 })).toEqual([
      { op: 'setTransform', clipId: 'a', transform: { fit: 'cover', scale: 1.3 } },
    ]);
    expect(planFraming(doc(), { clipId: 'a', x: 0.5, scale: 1 })).toEqual([]);
  });

  it('inherit drops the clip fit and keeps its zoom and position', () => {
    const framed = doc([
      { op: 'setTransform', clipId: 'a', transform: { fit: 'contain', x: 0.2, scale: 1.5 } },
    ]);
    const ops = planFraming(framed, { clipId: 'a', fit: 'inherit' });
    expect(ops[0]).toEqual({ op: 'clearTransform', clipId: 'a' });
    const after = applyOps(framed, ops).tracks[0]?.clips.find((c) => c.id === 'a');
    expect(after?.transform).toMatchObject({ x: 0.2, scale: 1.5 });
    expect(after?.transform && 'fit' in after.transform).toBe(false);
    expect(planFraming(doc(), { clipId: 'a', fit: 'inherit' })).toEqual([]);
  });

  it('reset clears the transform, then applies what else was asked', () => {
    const framed = doc([{ op: 'setTransform', clipId: 'a', transform: { x: 0.2, fit: 'cover' } }]);
    expect(planFraming(framed, { clipId: 'a', reset: true })).toEqual([
      { op: 'clearTransform', clipId: 'a' },
    ]);
    expect(planFraming(framed, { clipId: 'a', reset: true, y: 0 })).toEqual([
      { op: 'clearTransform', clipId: 'a' },
      { op: 'setTransform', clipId: 'a', transform: { y: 0 } },
    ]);
    expect(planFraming(doc(), { clipId: 'a', reset: true })).toEqual([]);
  });

  it('refuses text, color and missing clips, and an out-of-range zoom', () => {
    expect(() => planFraming(doc(), { clipId: 'cap', x: 0 })).toThrow(CompositionOpError);
    expect(() => planFraming(doc(), { clipId: 'card', scale: 2 })).toThrow(/only media clips/);
    expect(() => planFraming(doc(), { clipId: 'nope', x: 0 })).toThrow(/No clip "nope"/);
    expect(() => planFraming(doc(), { clipId: 'a', scale: 5 })).toThrow(/between 0.1 and 4/);
    expect(() => planFraming(doc(), { clipId: 'a', y: -0.1 })).toThrow(ReframeError);
  });
});
