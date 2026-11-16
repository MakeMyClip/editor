import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFilters, runFfmpeg } from '../../src/ffmpeg/run.js';
import {
  captionWidthBudget,
  defaultCaptionStyle,
  fitCaptionStyle,
  groupCaptions,
} from '../../src/timeline/captions.js';
import { buildFrameAtPlan } from '../../src/timeline/compile.js';
import { emptyComposition } from '../../src/timeline/composition.js';
import { applyOps, colorClip, textClip, videoTrack } from '../../src/timeline/ops.js';
import { runPlan } from '../../src/timeline/run-plan.js';

// Captions drawn by real FFmpeg on a 9:16 frame, measured with bbox: text and
// box must stay inside the safe area (x 151–929, bottom at or above y 1440).
// Runs where FFmpeg can draw text (CI's Linux build can't).
const IS_CI = process.env.CI === 'true';
const HAS_DRAWTEXT = IS_CI && (await listFilters()).has('drawtext');

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-safe-zone-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Bounding box of the bright pixels of an image. */
async function brightBox(
  image: string,
): Promise<{ x1: number; x2: number; y1: number; y2: number }> {
  const { stderr } = await runFfmpeg([
    ...['-hide_banner', '-i', image, '-vf', 'bbox=min_val=128', '-f', 'null', '-'],
  ]);
  const match = /x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)/.exec(stderr);
  if (!match) throw new Error(`no bbox in:\n${stderr.slice(-400)}`);
  const [x1, x2, y1, y2] = match.slice(1).map(Number) as [number, number, number, number];
  return { x1, x2, y1, y2 };
}

describe.skipIf(!HAS_DRAWTEXT)('captions inside the safe area, drawn by real FFmpeg', () => {
  it('keeps the widest all-caps captions on 1080x1920 inside x 151–929, above y 1440', async () => {
    const canvas = emptyComposition({ width: 1080, height: 1920, background: 'black' });
    const style = defaultCaptionStyle(canvas);
    const budget = captionWidthBudget(canvas, style);

    // All-caps speech grouped the way captions are: the longest lines it makes.
    const text =
      'SUBSCRIBE FOR MORE VIDEOS ABOUT EDITING PODCASTS WITHOUT WASTING HOURS EVERY WEEKEND WHATEVER HAPPENS';
    const words = text.split(' ').map((t, i) => ({
      index: i,
      text: t,
      startSec: i * 0.4,
      endSec: i * 0.4 + 0.35,
    }));
    const lines = groupCaptions(words, 60, 12, budget)
      .map((c) => c.text)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    // The widest letters, and a 96 px font: a W-heavy line and a long word.
    const big = { ...style, fontSize: 96 };
    const wide = groupCaptions(
      'WOW WOW WOW WOW'
        .split(' ')
        .map((t, i) => ({ index: i, text: t, startSec: i, endSec: i + 0.5 })),
      60,
      12,
      captionWidthBudget(canvas, big),
    ).map((c) => c.text);
    // The widest lowercase (m in DejaVu is 0.97 em) and Cyrillic capitals.
    const grouped = (text: string) =>
      groupCaptions(
        text.split(' ').map((t, i) => ({ index: i, text: t, startSec: i, endSec: i + 0.5 })),
        60,
        12,
        budget,
      ).map((c) => c.text);
    const cases = [
      ...lines.map((line) => ({ line, lineStyle: style })),
      ...wide.map((line) => ({ line, lineStyle: big })),
      { line: 'UNBELIEVABLE', lineStyle: fitCaptionStyle('UNBELIEVABLE', big, canvas) },
      ...grouped('mmm mmmm mmm mmmm mmm mmmm').map((line) => ({ line, lineStyle: style })),
      ...grouped('ШИРОКИЕ ЖЁЛТЫЕ ЩИТЫ ЮЖНЫХ ПЛОЩАДЕЙ').map((line) => ({ line, lineStyle: style })),
    ];

    for (const [i, { line, lineStyle }] of cases.entries()) {
      const doc = applyOps(canvas, [
        { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
        {
          op: 'addClip',
          trackId: 'v0',
          clip: colorClip({ id: 'bg', color: 'black', durationSec: 1, startSec: 0 }),
        },
        { op: 'addTrack', track: videoTrack({ id: 'captions' }) },
        {
          op: 'addClip',
          trackId: 'captions',
          // A light box, so the box's own edges are measured, not just the text.
          clip: textClip({
            id: 'c',
            text: line,
            durationSec: 1,
            startSec: 0,
            style: { ...lineStyle, background: 'white@0.6' },
          }),
        },
      ]);
      const frame = join(workspace, `line-${i}.png`);
      await runPlan(
        buildFrameAtPlan(doc, { media: new Map(), dir: workspace, output: frame }, 0.5),
      );
      const box = await brightBox(frame);
      expect(box.x1, line).toBeGreaterThanOrEqual(151);
      expect(box.x2, line).toBeLessThanOrEqual(929);
      expect(box.y2, line).toBeLessThanOrEqual(1440);
    }
  }, 60_000);
});
