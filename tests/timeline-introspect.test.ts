import { describe, expect, it } from 'vitest';
import {
  buildFrameAtPlan,
  CompileError,
  compileTimeline,
  type MediaInfo,
} from '../src/timeline/compile.js';
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

  /** The `-filter_complex` graph of a step. */
  const graphOf = (args: string[] | undefined): string =>
    args?.[(args?.indexOf('-filter_complex') ?? -2) + 1] ?? '';

  it('renders a media frame in one step from the source, through the segment chain', () => {
    const doc = applyOps(oneClip(), [
      { op: 'addEffect', clipId: 'c1', effect: { type: 'fadeIn', durationSec: 1 } },
    ]);
    const plan = buildFrameAtPlan(doc, CTX('/ws/frame.jpg'), 3);
    expect(plan.steps).toHaveLength(1);
    const [frame] = plan.steps;
    expect(frame?.label).toBe('frame:c1@3');
    // Seek a second before 3 s, keeping the frames from the keyframe before that.
    expect(frame?.args.slice(0, 6)).toEqual([
      '-y',
      '-noaccurate_seek',
      '-ss',
      '2',
      '-i',
      '/in.mp4',
    ]);
    expect(frame?.args.slice(-8)).toEqual([
      '-map',
      '[v]',
      '-an',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '/ws/frame.jpg',
    ]);
    // The same video chain export runs, on timestamps offset to the frame's time.
    const exported = graphOf(compileTimeline(doc, CTX('/ws/out.mp4')).steps[0]?.args);
    const segmentChain = exported.slice('[0:v]'.length, exported.indexOf('[v]'));
    expect(graphOf(frame?.args)).toBe(
      `[0:v]setpts=PTS+round(2/TB)-round(0/TB),trim=start=0,${segmentChain},trim=start=3[v]`,
    );
  });

  it('seeks into the source from the clip in-point and stops at its last frame', () => {
    const doc = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M, sourceInSec: 100, sourceOutSec: 108, startSec: 0 }),
      },
    ]);
    const near = buildFrameAtPlan(doc, CTX('/ws/f.jpg'), 7.999).steps[0];
    // 30 fps: the last frame starts at 8 - 1/30 s.
    // Rounded down, never past that frame or the clip's out-point.
    expect(near?.args.slice(2, 4)).toEqual(['-ss', '106.966666']);
    expect(graphOf(near?.args)).toMatch(
      /^\[0:v\]setpts=PTS\+round\(106\.966666\/TB\)-round\(100\/TB\),trim=start=0,/,
    );
    expect(graphOf(near?.args)).toMatch(/,trim=start=7\.96666666\d*\[v\]$/);
  });

  it('frames the picture the way export does (fit, zoom, position)', () => {
    const doc = applyOps(oneClip(), [
      { op: 'setCanvas', width: 1080, height: 1920, fit: 'cover' },
      { op: 'setTransform', clipId: 'c1', transform: { x: 0 } },
    ]);
    const seg = buildFrameAtPlan(doc, CTX('/ws/frame.jpg'), 3).steps[0];
    const graph = seg?.args[(seg?.args.indexOf('-filter_complex') ?? -2) + 1] ?? '';
    expect(graph).toContain('force_original_aspect_ratio=increase');
    expect(graph).toContain("crop=w='min(iw,1080)':h='min(ih,1920)':x='(iw-ow)*0'");
  });

  it('a tagged context gives a card segment a collision-free path; untagged stays stable', () => {
    const card = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: textClip({ id: 'c1', text: 'hi', durationSec: 8, startSec: 0 }),
      },
    ]);
    const segOut = (tag?: string) =>
      buildFrameAtPlan(card, { ...CTX('/ws/frame.jpg'), tag }, 3).steps[0]?.output;
    // Untagged keeps the deterministic name export also uses.
    expect(segOut()).toBe('/ws/tl-seg-0-c1.mp4');
    // A tag is mixed in, so a preview can't overwrite/unlink an export's segment…
    expect(segOut('frame-abc123')).toBe('/ws/tl-seg-frame-abc123-0-c1.mp4');
    // …and two different preview requests never share a segment path.
    expect(segOut('frame-aaa')).not.toBe(segOut('frame-bbb'));
  });

  it('takes the first frame at or after a time between frames, as export would', () => {
    // 30 fps: 3.01 s falls between the frames at 3.0 and 3.0333.
    const graph = graphOf(buildFrameAtPlan(oneClip(), CTX('/ws/f.jpg'), 3.01).steps[0]?.args);
    expect(graph).toMatch(/,trim=start=3\.0333333\d*\[v\]$/);
  });

  it("stops at the segment's last frame on a clip whose length is off the frame grid", () => {
    // 1.01 s at 30 fps encodes 30 frames, the last at 29/30 s.
    const short = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 1.01, startSec: 0 }),
      },
    ]);
    const graph = graphOf(buildFrameAtPlan(short, CTX('/ws/f.jpg'), 1.009).steps[0]?.args);
    expect(graph).toMatch(/,trim=start=0\.9666666\d*\[v\]$/);
  });

  it('selects the second clip and offsets into it for a time in the second clip', () => {
    const doc = applyOps(oneClip(), [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c2', mediaId: M, sourceInSec: 1, sourceOutSec: 5, startSec: 8 }),
      },
    ]);
    const plan = buildFrameAtPlan(doc, CTX('/ws/f.jpg'), 10); // 2s into c2 ([8,12))
    expect(plan.steps[0]?.label).toBe('frame:c2@10');
    expect(plan.steps[0]?.args.slice(2, 4)).toEqual(['-ss', '2']);
    expect(graphOf(plan.steps[0]?.args)).toMatch(
      /^\[0:v\]setpts=PTS\+round\(2\/TB\)-round\(1\/TB\),/,
    );
    expect(graphOf(plan.steps[0]?.args)).toMatch(/,trim=start=2\[v\]$/);
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
    // The frame shows source second 4;
    // the chain's setpts=PTS/2 turns source time into segment time, which the
    // fades and text windows read, and trim takes the frame at segment time 2.
    const frame = buildFrameAtPlan(doc, CTX('/ws/f.jpg'), 4).steps[0];
    expect(frame?.args.slice(2, 4)).toEqual(['-ss', '3']);
    const graph = graphOf(frame?.args);
    expect(graph).toMatch(/^\[0:v\]setpts=PTS\+round\(3\/TB\)-round\(0\/TB\),/);
    expect(graph).toContain('setpts=PTS/2');
    expect(graph).toMatch(/,trim=start=2\[v\]$/);
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
