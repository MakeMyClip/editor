import { describe, expect, it } from 'vitest';
import { buildFrameAtPlan, CompileError, type MediaInfo } from '../src/timeline/compile.js';
import { clipsAtTime, emptyComposition } from '../src/timeline/composition.js';
import { applyOps, mediaClip, textClip, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;
const MEDIA = new Map<MediaId, MediaInfo>([[M, { path: '/in.mp4', hasAudio: true }]]);
const CTX = (output: string) => ({ media: MEDIA, dir: '/ws', output });

describe('clipsAtTime', () => {
  const doc = applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'a', mediaId: M, sourceOutSec: 5, startSec: 0 }),
    },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'b', mediaId: M, sourceOutSec: 4, startSec: 5 }),
    },
    {
      op: 'addClip',
      trackId: 'v1',
      clip: textClip({ id: 't', text: 'hi', durationSec: 3, startSec: 0 }),
    },
  ]);

  it('is half-open: the boundary belongs to the later clip', () => {
    expect(
      clipsAtTime(doc, 0)
        .map((h) => h.clip.id)
        .sort(),
    ).toEqual(['a', 't']);
    expect(clipsAtTime(doc, 4.999).map((h) => h.clip.id)).toContain('a');
    // At exactly 5, clip 'a' ([0,5)) ends and 'b' ([5,9)) begins → 'b', not 'a'.
    expect(clipsAtTime(doc, 5).map((h) => h.clip.id)).not.toContain('a');
    expect(clipsAtTime(doc, 5).map((h) => h.clip.id)).toContain('b');
  });

  it('returns every track live at the time, with the offset into each clip', () => {
    const hits = clipsAtTime(doc, 2);
    expect(hits.map((h) => h.clip.id).sort()).toEqual(['a', 't']);
    expect(hits.find((h) => h.clip.id === 'a')?.localOffsetSec).toBe(2);
  });

  it('returns nothing in a gap or past the end', () => {
    expect(clipsAtTime(doc, 9)).toEqual([]); // 'b' ends at 9 (half-open)
    expect(clipsAtTime(doc, 100)).toEqual([]);
  });
});

describe('buildFrameAtPlan', () => {
  function oneClip() {
    return applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 8, startSec: 0 }),
      },
    ]);
  }

  it('encodes the clip segment then extracts the frame at the doc-local offset', () => {
    const plan = buildFrameAtPlan(oneClip(), CTX('/ws/frame.jpg'), 3);
    expect(plan.steps).toHaveLength(2);
    const [seg, frame] = plan.steps;
    expect(seg?.label).toBe('segment:c1');
    expect(frame?.label).toContain('frame:c1');
    expect(frame?.output).toBe('/ws/frame.jpg');
    // -ss <offset> -i <segment> … <output>
    expect(frame?.args.slice(0, 2)).toEqual(['-y', '-ss']);
    expect(Number(frame?.args[2])).toBeCloseTo(3);
    expect(frame?.args[4]).toBe(seg?.output); // reads the encoded segment
    expect(frame?.args.at(-1)).toBe('/ws/frame.jpg');
  });

  it('selects the second clip and offsets into it for a time in the second clip', () => {
    const doc = applyOps(oneClip(), [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c2', mediaId: M, sourceOutSec: 4, startSec: 8 }),
      },
    ]);
    const plan = buildFrameAtPlan(doc, CTX('/ws/f.jpg'), 10); // 2s into c2 ([8,12))
    expect(plan.steps[0]?.label).toBe('segment:c2');
    expect(Number(plan.steps[1]?.args[2])).toBeCloseTo(2);
  });

  it('maps doc-local time to the post-speed segment timebase for a speed clip', () => {
    // 8s source at 2x → segment is 4s; doc-local 4s maps to segment time 2s.
    const doc = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({
          id: 'c1',
          mediaId: M,
          sourceOutSec: 8,
          startSec: 0,
          effects: [{ type: 'speed', factor: 2 }],
        }),
      },
    ]);
    const plan = buildFrameAtPlan(doc, CTX('/ws/f.jpg'), 4);
    expect(Number(plan.steps[1]?.args[2])).toBeCloseTo(2);
  });

  it('works on a text clip (no media required)', () => {
    const doc = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: textClip({ id: 't1', text: 'hi', durationSec: 4, startSec: 0 }),
      },
    ]);
    const plan = buildFrameAtPlan(doc, CTX('/ws/f.jpg'), 1);
    expect(plan.steps[0]?.label).toBe('segment:t1');
    expect(Number(plan.steps[1]?.args[2])).toBeCloseTo(1);
  });

  it('throws past the end', () => {
    expect(() => buildFrameAtPlan(oneClip(), CTX('/ws/f.jpg'), 9)).toThrow(CompileError);
  });

  it('throws in a gap', () => {
    const doc = applyOps(oneClip(), [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c2', mediaId: M, sourceOutSec: 4, startSec: 12 }),
      },
    ]);
    // c1 is [0,8), c2 is [12,16); 10s is in the gap.
    expect(() => buildFrameAtPlan(doc, CTX('/ws/f.jpg'), 10)).toThrow(CompileError);
  });

  it('throws before the start', () => {
    expect(() => buildFrameAtPlan(oneClip(), CTX('/ws/f.jpg'), -1)).toThrow(CompileError);
  });

  it('throws on an overlapping (unexportable) timeline instead of guessing a clip', () => {
    const doc = applyOps(oneClip(), [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c2', mediaId: M, sourceOutSec: 6, startSec: 4 }),
      },
    ]);
    // c1 [0,8) and c2 [4,10) overlap on one track — export rejects this, so frame must too.
    expect(() => buildFrameAtPlan(doc, CTX('/ws/f.jpg'), 5)).toThrow(CompileError);
  });
});
