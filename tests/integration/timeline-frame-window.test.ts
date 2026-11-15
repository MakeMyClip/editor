import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPreviewFrameArgs } from '../../src/ffmpeg/args/preview.js';
import { listFilters, runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildFrameAtPlan, compileTimeline, type MediaInfo } from '../../src/timeline/compile.js';
import {
  type Composition,
  emptyComposition,
  type MediaClip,
} from '../../src/timeline/composition.js';
import { applyOps, mediaClip, textClip, videoTrack } from '../../src/timeline/ops.js';
import { runPlan } from '../../src/timeline/run-plan.js';
import type { MediaId } from '../../src/timeline/schema.js';

// The frame preview runs the segment's video chain on a window of the source
// starting at the frame. This checks it against the frame cut out of the fully
// encoded clip, which is what export plays, and that it doesn't grow with the
// clip's length.
const IS_CI = process.env.CI === 'true';
const HAS_DRAWTEXT = IS_CI && (await listFilters()).has('drawtext');
const M = 'm_aaaaaaaaaaaa' as MediaId;

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-frame-window-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** 720p30 test pattern (its counter and gradient move every frame) with a 2 s GOP. */
async function testPattern(path: string, seconds: number): Promise<void> {
  await runFfmpeg([
    ...['-hide_banner', '-loglevel', 'error'],
    ...['-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=30:duration=${seconds}`],
    ...['-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${seconds}`],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p'],
    ...['-c:a', 'aac', '-shortest', path],
  ]);
}

/** A vertical timeline holding one clip of the source, framed off-center. */
function vertical(clip: MediaClip, withText = false): Composition {
  return applyOps(emptyComposition({ width: 1080, height: 1920, fit: 'cover' }), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    { op: 'addClip', trackId: 'v0', clip: { ...clip, transform: { ...clip.transform, x: 0.3 } } },
    ...(withText
      ? [
          { op: 'addTrack' as const, track: videoTrack({ id: 'captions' }) },
          {
            op: 'addClip' as const,
            trackId: 'captions',
            clip: textClip({
              id: 't1',
              text: 'Caption over the picture',
              startSec: 2,
              durationSec: 2,
              style: { fontSize: 54, background: 'black@0.6', anchor: 'bottom-center' },
            }),
          },
        ]
      : []),
  ]);
}

/** PSNR between two images, dB. */
async function psnr(a: string, b: string): Promise<number> {
  const { stderr } = await runFfmpeg([
    ...['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'],
  ]);
  const match = /average:([\d.]+|inf)/.exec(stderr);
  if (!match?.[1]) throw new Error(`No PSNR in:\n${stderr}`);
  return match[1] === 'inf' ? Number.POSITIVE_INFINITY : Number(match[1]);
}

describe.skipIf(!IS_CI)('frame preview from a short window, against real FFmpeg', () => {
  it('matches the frame of the fully encoded clip: mid-clip, in a fade, at 2x', async () => {
    const source = join(workspace, 'pattern.mp4');
    await testPattern(source, 20);
    const media = new Map<MediaId, MediaInfo>([[M, { path: source, hasAudio: true }]]);
    const cases: { name: string; doc: Composition; atSec: number; exportSec: number }[] = [
      {
        name: 'mid-clip',
        doc: vertical(
          mediaClip({ id: 'c1', mediaId: M, sourceInSec: 5, sourceOutSec: 15, startSec: 0 }),
          HAS_DRAWTEXT,
        ),
        atSec: 3,
        exportSec: 3,
      },
      {
        name: 'inside a fade',
        doc: vertical(
          mediaClip({
            id: 'c1',
            mediaId: M,
            sourceInSec: 5,
            sourceOutSec: 15,
            startSec: 0,
            effects: [{ type: 'fadeIn', durationSec: 2 }],
          }),
        ),
        atSec: 1,
        exportSec: 1,
      },
      {
        // 8 s of source at 2x plays in 4 s: timeline 4 s is export 2 s.
        name: 'at 2x speed',
        doc: vertical(
          mediaClip({
            id: 'c1',
            mediaId: M,
            sourceInSec: 4,
            sourceOutSec: 12,
            startSec: 0,
            effects: [
              { type: 'speed', factor: 2 },
              { type: 'fadeIn', durationSec: 3 },
            ],
          }),
        ),
        atSec: 4,
        exportSec: 2,
      },
    ];

    for (const { name, doc, atSec, exportSec } of cases) {
      const tag = name.replace(/\W+/g, '-');
      const exported = join(workspace, `${tag}.mp4`);
      await runPlan(compileTimeline(doc, { media, dir: workspace, output: exported }));
      const full = join(workspace, `${tag}-full.jpg`);
      await runFfmpeg(buildPreviewFrameArgs({ input: exported, output: full, atSec: exportSec }));

      const windowFrame = join(workspace, `${tag}-window.jpg`);
      const plan = buildFrameAtPlan(doc, { media, dir: workspace, output: windowFrame }, atSec);
      expect(plan.steps, name).toHaveLength(1);
      await runPlan(plan);

      expect(await psnr(full, windowFrame), name).toBeGreaterThanOrEqual(40);
    }
  }, 180_000);

  it('renders a frame near the end of a 10-minute clip in under a second', async () => {
    const piece = join(workspace, 'piece.mp4');
    const source = join(workspace, 'ten-minutes.mp4');
    await testPattern(piece, 30);
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-stream_loop', '19', '-i', piece, '-c', 'copy', source],
    ]);
    const media = new Map<MediaId, MediaInfo>([[M, { path: source, hasAudio: true }]]);
    const doc = vertical(mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 600, startSec: 0 }));
    const output = join(workspace, 'late.jpg');

    const started = performance.now();
    await runPlan(buildFrameAtPlan(doc, { media, dir: workspace, output }, 540));
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);
});
