import { mkdtemp, rm, stat } from 'node:fs/promises';
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

/** 720p test pattern with a 2 s GOP. Its hue turns 24 degrees a frame, so
 *  every frame differs all over and a frame off by one fails the PSNR check. */
async function testPattern(path: string, seconds: number, rate = 30): Promise<void> {
  await runFfmpeg([
    ...['-hide_banner', '-loglevel', 'error'],
    ...[
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=1280x720:rate=${rate}:duration=${seconds},hue=h=t*${24 * rate}`,
    ],
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
        name: 'between two frames',
        doc: vertical(
          mediaClip({ id: 'c1', mediaId: M, sourceInSec: 5, sourceOutSec: 15, startSec: 0 }),
        ),
        atSec: 3.01,
        exportSec: 3.01,
      },
      {
        // 1.01 s encodes 30 frames at 30 fps; the last one is at 29/30 s.
        name: 'the last frame of a clip off the frame grid',
        doc: vertical(
          mediaClip({ id: 'c1', mediaId: M, sourceInSec: 5, sourceOutSec: 6.01, startSec: 0 }),
        ),
        atSec: 1.009,
        exportSec: 29 / 30,
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

    // A 24 fps source on the 30 fps canvas: export repeats some source frames,
    // and the preview shows the one export plays, up to the clip's very end.
    const slow = join(workspace, 'slow.mp4');
    await testPattern(slow, 4, 24);
    const slowMedia = new Map<MediaId, MediaInfo>([[M, { path: slow, hasAudio: true }]]);
    const slowDoc = vertical(mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 4, startSec: 0 }));
    const slowExport = join(workspace, 'slow-export.mp4');
    await runPlan(
      compileTimeline(slowDoc, { media: slowMedia, dir: workspace, output: slowExport }),
    );
    // 1.391 s: the seek's whole-tick rounding decides which side of a frame
    // boundary the source frame at 1.4167 s lands on.
    for (const atSec of [1.5, 1.391, 3.999]) {
      const full = join(workspace, `slow-${atSec}-full.jpg`);
      const exportSec = Math.min(atSec, 4 - 1 / 30);
      await runFfmpeg(buildPreviewFrameArgs({ input: slowExport, output: full, atSec: exportSec }));
      const windowFrame = join(workspace, `slow-${atSec}-window.jpg`);
      await runPlan(
        buildFrameAtPlan(slowDoc, { media: slowMedia, dir: workspace, output: windowFrame }, atSec),
      );
      expect(await psnr(full, windowFrame), `24 fps at ${atSec}`).toBeGreaterThanOrEqual(40);
    }

    // Slow motion: at 0.25x a canvas frame can need the source frame before the
    // keyframe the frame's own time falls just after (2.5 s here, a 60-frame GOP).
    const slowMotion = vertical(
      mediaClip({
        id: 'c1',
        mediaId: M,
        sourceInSec: 0.01,
        sourceOutSec: 4,
        startSec: 0,
        effects: [{ type: 'speed', factor: 0.25 }],
      }),
    );
    const slowMotionExport = join(workspace, 'slow-motion.mp4');
    await runPlan(
      compileTimeline(slowMotion, { media: slowMedia, dir: workspace, output: slowMotionExport }),
    );
    const slowMotionFull = join(workspace, 'slow-motion-full.jpg');
    // Timeline 2.491 s of a 0.25x clip plays at 9.964 s of its segment.
    await runFfmpeg(
      buildPreviewFrameArgs({ input: slowMotionExport, output: slowMotionFull, atSec: 9.964 }),
    );
    const slowMotionWindow = join(workspace, 'slow-motion-window.jpg');
    await runPlan(
      buildFrameAtPlan(
        slowMotion,
        { media: slowMedia, dir: workspace, output: slowMotionWindow },
        2.491,
      ),
    );
    expect(await psnr(slowMotionFull, slowMotionWindow), 'slow motion').toBeGreaterThanOrEqual(40);

    // A sparse source (a frame every 5 s, like a screen recording holding a
    // still): at 18 s export still shows the frame from 15 s.
    const sparse = join(workspace, 'sparse.mp4');
    await testPattern(sparse, 25, 0.2);
    const sparseMedia = new Map<MediaId, MediaInfo>([[M, { path: sparse, hasAudio: true }]]);
    const sparseDoc = vertical(mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 25, startSec: 0 }));
    const sparseExport = join(workspace, 'sparse-export.mp4');
    await runPlan(
      compileTimeline(sparseDoc, { media: sparseMedia, dir: workspace, output: sparseExport }),
    );
    const sparseFull = join(workspace, 'sparse-full.jpg');
    await runFfmpeg(buildPreviewFrameArgs({ input: sparseExport, output: sparseFull, atSec: 18 }));
    const sparseWindow = join(workspace, 'sparse-window.jpg');
    await runPlan(
      buildFrameAtPlan(sparseDoc, { media: sparseMedia, dir: workspace, output: sparseWindow }, 18),
    );
    expect(await psnr(sparseFull, sparseWindow), 'sparse source').toBeGreaterThanOrEqual(40);

    // The very end of a clip that ends with its source: the seek must not pass
    // the last frame, or there is no image.
    const whole = vertical(mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 20, startSec: 0 }));
    const last = join(workspace, 'last.jpg');
    await runPlan(buildFrameAtPlan(whole, { media, dir: workspace, output: last }, 19.999));
    expect((await stat(last)).size).toBeGreaterThan(0);
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
