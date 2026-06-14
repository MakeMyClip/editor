import { describe, expect, it } from 'vitest';
import { clipDuration, emptyComposition, findClip } from '../src/timeline/composition.js';
import {
  applyOp,
  applyOps,
  CompositionOpError,
  mediaClip,
  textClip,
  videoTrack,
} from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';

const M1 = 'm_aaaaaaaaaaaa' as MediaId;
const M2 = 'm_bbbbbbbbbbbb' as MediaId;

/** A 1-video-track composition with a single 0..5s media clip "c1". */
function oneClip() {
  return applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c1', mediaId: M1, sourceOutSec: 5, startSec: 0 }),
    },
  ]);
}

describe('applyOp — purity & validity', () => {
  it('does not mutate the input composition', () => {
    const before = oneClip();
    const snapshot = structuredClone(before);
    applyOp(before, { op: 'removeClip', clipId: 'c1' });
    expect(before).toEqual(snapshot);
  });

  it('always returns a schema-valid composition', () => {
    const comp = oneClip();
    // effects default is materialized, etc.
    expect(comp.tracks[0]?.clips[0]?.effects).toEqual([]);
  });
});

describe('tracks & clips', () => {
  it('adds clips sorted by timeline start regardless of insertion order', () => {
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'late', mediaId: M1, sourceOutSec: 2, startSec: 10 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'early', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
    ]);
    expect(comp.tracks[0]?.clips.map((c) => c.id)).toEqual(['early', 'late']);
  });

  it('rejects adding a clip to a missing track', () => {
    expect(() =>
      applyOp(emptyComposition(), {
        op: 'addClip',
        trackId: 'ghost',
        clip: mediaClip({ id: 'c', mediaId: M1, sourceOutSec: 1, startSec: 0 }),
      }),
    ).toThrow(CompositionOpError);
  });

  it('rejects a duplicate clip id', () => {
    expect(() =>
      applyOp(oneClip(), {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M2, sourceOutSec: 1, startSec: 6 }),
      }),
    ).toThrow(/already exists/);
  });

  it('removeClip drops the clip and its dangling transitions', () => {
    let comp = applyOps(oneClip(), [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c2', mediaId: M2, sourceOutSec: 3, startSec: 5 }),
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'c1', kind: 'fade', durationSec: 1 },
      },
    ]);
    comp = applyOp(comp, { op: 'removeClip', clipId: 'c1' });
    expect(findClip(comp, 'c1')).toBeNull();
    expect(comp.tracks[0]?.transitions).toEqual([]);
  });

  it('moveClip retimes and can move across tracks', () => {
    let comp = applyOps(oneClip(), [{ op: 'addTrack', track: videoTrack({ id: 'v1' }) }]);
    comp = applyOp(comp, { op: 'moveClip', clipId: 'c1', startSec: 3, toTrackId: 'v1' });
    expect(findClip(comp, 'c1')?.track.id).toBe('v1');
    expect(findClip(comp, 'c1')?.clip.startSec).toBe(3);
    expect(comp.tracks.find((t) => t.id === 'v0')?.clips).toEqual([]);
  });
});

describe('trim, duration, split', () => {
  it('setTrim adjusts the source window and rejects out<=in', () => {
    const comp = applyOp(oneClip(), {
      op: 'setTrim',
      clipId: 'c1',
      sourceInSec: 1,
      sourceOutSec: 4,
    });
    const clip = findClip(comp, 'c1')?.clip;
    expect(clip && clipDuration(clip)).toBe(3);
    expect(() =>
      applyOp(comp, { op: 'setTrim', clipId: 'c1', sourceInSec: 4, sourceOutSec: 4 }),
    ).toThrow(/greater than/);
  });

  it('setTrim refuses non-media clips', () => {
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: textClip({ id: 't', text: 'hi', durationSec: 2, startSec: 0 }),
      },
    ]);
    expect(() => applyOp(comp, { op: 'setTrim', clipId: 't', sourceOutSec: 1 })).toThrow(
      /media clips/,
    );
  });

  it('splitClip cuts a media clip into two contiguous halves', () => {
    const comp = applyOp(oneClip(), { op: 'splitClip', clipId: 'c1', atSec: 2, newClipId: 'c1b' });
    const a = findClip(comp, 'c1')?.clip;
    const b = findClip(comp, 'c1b')?.clip;
    expect(a && clipDuration(a)).toBe(2);
    expect(b && clipDuration(b)).toBe(3);
    expect(b?.startSec).toBe(2);
    if (a?.kind === 'media' && b?.kind === 'media') {
      expect(a.sourceOutSec).toBe(b.sourceInSec); // contiguous, no gap/overlap in source
    }
  });

  it('splitClip rejects a cut outside the clip', () => {
    expect(() =>
      applyOp(oneClip(), { op: 'splitClip', clipId: 'c1', atSec: 9, newClipId: 'x' }),
    ).toThrow(/outside clip/);
  });
});

describe('effects & transform', () => {
  it('addEffect appends in order; removeEffect drops by index', () => {
    let comp = applyOps(oneClip(), [
      {
        op: 'addEffect',
        clipId: 'c1',
        effect: { type: 'adjust', brightness: 0.1, contrast: 1, saturation: 1 },
      },
      { op: 'addEffect', clipId: 'c1', effect: { type: 'speed', factor: 2 } },
    ]);
    expect(findClip(comp, 'c1')?.clip.effects.map((e) => e.type)).toEqual(['adjust', 'speed']);
    comp = applyOp(comp, { op: 'removeEffect', clipId: 'c1', index: 0 });
    expect(findClip(comp, 'c1')?.clip.effects.map((e) => e.type)).toEqual(['speed']);
  });

  it('rejects an out-of-range effect index', () => {
    expect(() => applyOp(oneClip(), { op: 'removeEffect', clipId: 'c1', index: 0 })).toThrow(
      /out of range/,
    );
  });

  it('setTransform merges into the existing transform', () => {
    let comp = applyOp(oneClip(), { op: 'setTransform', clipId: 'c1', transform: { scale: 2 } });
    comp = applyOp(comp, { op: 'setTransform', clipId: 'c1', transform: { x: 0.25 } });
    const t = findClip(comp, 'c1')?.clip.transform;
    expect(t).toMatchObject({ scale: 2, x: 0.25, y: 0.5, opacity: 1 });
  });
});

describe('transitions', () => {
  it('addTransition requires the anchor clip; replaces an existing one on the same boundary', () => {
    const comp = applyOps(oneClip(), [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c2', mediaId: M2, sourceOutSec: 3, startSec: 5 }),
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'c1', kind: 'fade', durationSec: 1 },
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'c1', kind: 'wipeleft', durationSec: 2 },
      },
    ]);
    expect(comp.tracks[0]?.transitions).toHaveLength(1);
    expect(comp.tracks[0]?.transitions[0]).toMatchObject({
      afterClipId: 'c1',
      kind: 'wipeleft',
      durationSec: 2,
    });
    expect(() =>
      applyOp(comp, {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'ghost', kind: 'fade', durationSec: 1 },
      }),
    ).toThrow(/no such clip/);
  });

  it('splitClip moves a boundary transition to the new second half', () => {
    let comp = applyOps(oneClip(), [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c2', mediaId: M2, sourceOutSec: 3, startSec: 5 }),
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'c1', kind: 'fade', durationSec: 1 },
      },
    ]);
    comp = applyOp(comp, { op: 'splitClip', clipId: 'c1', atSec: 2, newClipId: 'c1b' });
    // The transition that played after c1 should now follow the second half c1b.
    expect(comp.tracks[0]?.transitions[0]?.afterClipId).toBe('c1b');
  });
});
