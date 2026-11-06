import { describe, expect, it } from 'vitest';
import { buildCellStillArgs, buildContactSheetArgs } from '../src/ffmpeg/args/contact-sheet.js';
import { buildPeakVolumeArgs } from '../src/ffmpeg/args/volume-detect.js';
import type { MediaInfo } from '../src/timeline/compile.js';
import { type Composition, emptyComposition } from '../src/timeline/composition.js';
import { applyOps, colorClip, mediaClip, videoTrack } from '../src/timeline/ops.js';
import {
  CUT_EDGE_SEC,
  checkCuts,
  classifyCut,
  edgeGainDb,
  edgeWindow,
  hardCuts,
  parseMaxVolume,
  ReviewError,
  reviewCuts,
} from '../src/timeline/review.js';
import type { MediaId } from '../src/timeline/schema.js';

const A = 'm_aaaaaaaaaaaa' as MediaId;
const B = 'm_bbbbbbbbbbbb' as MediaId;
const MEDIA = new Map<MediaId, MediaInfo>([
  [A, { path: '/ws/a.mp4', hasAudio: true }],
  [B, { path: '/ws/b.mp4', hasAudio: false }],
]);

/** v0: a [0,2) | b [2,3) → fade → c [3,5) | gap | d [6,7); v1: card [0,1) | e [1,2). */
function doc(): Composition {
  return applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'a', mediaId: A, sourceInSec: 1, sourceOutSec: 3, startSec: 0 }),
    },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'b', mediaId: A, sourceInSec: 5, sourceOutSec: 6, startSec: 2 }),
    },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c', mediaId: A, sourceOutSec: 2, startSec: 3 }),
    },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'd', mediaId: A, sourceOutSec: 1, startSec: 6 }),
    },
    {
      op: 'addTransition',
      trackId: 'v0',
      transition: { afterClipId: 'b', kind: 'fade', durationSec: 0.5 },
    },
    { op: 'addClip', trackId: 'v1', clip: colorClip({ id: 'card', durationSec: 1, startSec: 0 }) },
    {
      op: 'addClip',
      trackId: 'v1',
      clip: mediaClip({ id: 'e', mediaId: B, sourceOutSec: 1, startSec: 1 }),
    },
  ]);
}

describe('hardCuts', () => {
  it('finds abutting joins with no transition, on every track', () => {
    expect(hardCuts(doc())).toEqual([
      { trackId: 'v0', atSec: 2, outClipId: 'a', inClipId: 'b' },
      { trackId: 'v1', atSec: 1, outClipId: 'card', inClipId: 'e' },
    ]);
  });
});

describe('classifyCut', () => {
  it.each([
    [-6, -6, true, 'Sound on both sides'],
    [-6, -60, true, 'ends in sound'],
    [-60, -6, true, 'starts in sound'],
    [-60, -91, false, null],
    [null, -6, true, 'starts in sound'],
    [null, null, false, null],
  ])('out %s dB, in %s dB → flagged %s', (out, inc, flagged, reason) => {
    const result = classifyCut(out, inc);
    expect(result.flagged).toBe(flagged);
    if (reason) expect(result.reason).toContain(reason);
    else expect(result.reason).toBeNull();
  });
});

describe('edgeWindow', () => {
  it('measures the last and first CUT_EDGE_SEC of the source window', () => {
    const clip = mediaClip({ id: 'x', mediaId: A, sourceInSec: 1, sourceOutSec: 3, startSec: 0 });
    expect(edgeWindow(clip, 'end')).toEqual({
      mediaId: A,
      startSec: 3 - CUT_EDGE_SEC,
      durationSec: CUT_EDGE_SEC,
    });
    expect(edgeWindow(clip, 'start')).toEqual({
      mediaId: A,
      startSec: 1,
      durationSec: CUT_EDGE_SEC,
    });
  });

  it('shrinks to a clip shorter than the window, and skips generated clips', () => {
    const tiny = mediaClip({
      id: 'x',
      mediaId: A,
      sourceInSec: 1,
      sourceOutSec: 1.02,
      startSec: 0,
    });
    expect(edgeWindow(tiny, 'end')?.durationSec).toBeCloseTo(0.02, 10);
    expect(edgeWindow(colorClip({ id: 'c', durationSec: 1, startSec: 0 }), 'end')).toBeNull();
  });
});

describe('parseMaxVolume', () => {
  it('reads max_volume, floors -inf, and returns null when absent', () => {
    expect(parseMaxVolume('[Parsed_volumedetect_0 @ 0x1] max_volume: -6.0 dB')).toBe(-6);
    expect(parseMaxVolume('[Parsed_volumedetect_0 @ 0x1] max_volume: -inf dB')).toBe(-120);
    expect(parseMaxVolume('no audio here')).toBeNull();
  });
});

describe('checkCuts', () => {
  it('measures each media side, skips generated or silent-track sides, and flags loud joins', async () => {
    const calls: [string, number, number][] = [];
    const report = await checkCuts(doc(), MEDIA, async (input, startSec, durationSec) => {
      calls.push([input, startSec, durationSec]);
      return startSec === 5 ? -6 : -70;
    });
    // a's end (source 3) and b's start (source 5); card is generated, e has no audio.
    expect(calls).toEqual([
      ['/ws/a.mp4', 3 - CUT_EDGE_SEC, CUT_EDGE_SEC],
      ['/ws/a.mp4', 5, CUT_EDGE_SEC],
    ]);
    expect(report.flagged).toBe(1);
    expect(report.cuts[0]).toMatchObject({
      outClipId: 'a',
      outPeakDb: -70,
      inPeakDb: -6,
      flagged: true,
    });
    expect(report.cuts[1]).toMatchObject({
      outClipId: 'card',
      outPeakDb: null,
      inPeakDb: null,
      flagged: false,
    });
  });

  it('refuses a clip whose media is not registered', async () => {
    await expect(checkCuts(doc(), new Map(), async () => -70)).rejects.toBeInstanceOf(ReviewError);
  });

  it('applies volume gains and the most a fade can leave in the window', async () => {
    const withEffects = applyOps(doc(), [
      { op: 'addEffect', clipId: 'a', effect: { type: 'volume', gain: 0.1 } },
      { op: 'addEffect', clipId: 'b', effect: { type: 'fadeIn', durationSec: 0.3 } },
    ]);
    const measured: number[] = [];
    const report = await checkCuts(withEffects, MEDIA, async (_input, startSec) => {
      measured.push(startSec);
      return -6;
    });
    // a's end: -6 dB source - 20 dB gain = -26 dB. b's start: a 0.3 s fade passes
    // at most 0.06 / 0.3 of the level in a 60 ms window (-14 dB) → -20 dB, still loud.
    expect(measured).toEqual([3 - CUT_EDGE_SEC, 5]);
    expect(report.cuts[0]).toMatchObject({ outPeakDb: -26, inPeakDb: -20, flagged: true });
  });

  it('treats a muted edge as silence without measuring it', async () => {
    const muted = applyOps(doc(), [
      { op: 'addEffect', clipId: 'a', effect: { type: 'volume', gain: 0 } },
    ]);
    const measured: number[] = [];
    const report = await checkCuts(muted, MEDIA, async (_input, startSec) => {
      measured.push(startSec);
      return -60;
    });
    expect(measured).toEqual([5]);
    expect(report.cuts[0]).toMatchObject({ outPeakDb: -120, flagged: false });
  });
});

describe('edgeGainDb', () => {
  const clip = (effects: Parameters<typeof mediaClip>[0]['effects']) =>
    mediaClip({ id: 'x', mediaId: A, sourceOutSec: 2, startSec: 0, effects });

  it('adds volume gains in dB', () => {
    const gains = clip([
      { type: 'volume', gain: 2 },
      { type: 'volume', gain: 0.5 },
    ]);
    expect(edgeGainDb(gains, 'start')).toBeCloseTo(0, 10);
  });

  it('bounds a fade by window / fade, only on its own edge', () => {
    const faded = clip([{ type: 'fadeOut', durationSec: 0.5 }]);
    expect(edgeGainDb(faded, 'end')).toBeCloseTo(20 * Math.log10(0.06 / 0.5), 10);
    expect(edgeGainDb(faded, 'start')).toBe(0);
    // A fade shorter than the window can't lower the window's peak.
    expect(edgeGainDb(clip([{ type: 'fadeOut', durationSec: 0.001 }]), 'end')).toBe(0);
    // At 2x speed the 60 ms source window lasts 30 ms of output.
    const fast = clip([
      { type: 'speed', factor: 2 },
      { type: 'fadeOut', durationSec: 0.5 },
    ]);
    expect(edgeGainDb(fast, 'end')).toBeCloseTo(20 * Math.log10(0.03 / 0.5), 10);
    // Export clamps a fade to the clip, so a 100 s fade on a 0.5 s clip acts as 0.5 s.
    const short = mediaClip({
      id: 'y',
      mediaId: A,
      sourceOutSec: 0.5,
      startSec: 0,
      effects: [{ type: 'fadeOut', durationSec: 100 }],
    });
    expect(edgeGainDb(short, 'end')).toBeCloseTo(20 * Math.log10(0.06 / 0.5), 10);
  });
});

describe('reviewCuts', () => {
  it('skips the sheet for audio-only sources and keeps the audio report', async () => {
    const audioOnly = new Map<MediaId, MediaInfo>([
      [A, { path: '/ws/a.m4a', hasAudio: true, hasVideo: false }],
      [B, { path: '/ws/b.m4a', hasAudio: false, hasVideo: false }],
    ]);
    const review = await reviewCuts(doc(), audioOnly, '/ws/sheet.jpg', '/ws', async () => -70);
    expect(review).toMatchObject({ flagged: 0, sheet: null, sheetError: null });
    expect(review.cuts).toHaveLength(2);
  });
});

describe('arg builders', () => {
  it('peak volume: one source window, first audio stream, output discarded', () => {
    expect(buildPeakVolumeArgs({ input: '/ws/a.mp4', startSec: 2.94, durationSec: 0.06 })).toEqual([
      '-hide_banner',
      '-nostats',
      '-ss',
      '2.94',
      '-t',
      '0.06',
      '-i',
      '/ws/a.mp4',
      '-map',
      '0:a:0',
      '-af',
      'aformat=sample_rates=48000:channel_layouts=stereo,volumedetect',
      '-f',
      'null',
      '-',
    ]);
  });

  it('cell still: a frame from inside the window, fitted to the cell in one format', () => {
    const vf =
      "select='lt(t,0.25)',scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=320:180:(ow-iw)/2:(oh-ih)/2";
    const still = (pick: 'first' | 'last') =>
      buildCellStillArgs({
        input: '/ws/a.mp4',
        output: '/ws/f-001.jpg',
        startSec: 2.75,
        durationSec: 0.25,
        pick,
        cellWidth: 320,
        cellHeight: 180,
      });
    const tail = ['-vf', vf, '-pix_fmt', 'yuvj420p', '-q:v', '4', '-an', '/ws/f-001.jpg'];
    const head = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '2.75', '-t', '1.25'];
    expect(still('first')).toEqual([
      ...head,
      ...['-i', '/ws/a.mp4', '-map', '0:v:0', '-frames:v', '1'],
      ...tail,
    ]);
    expect(still('last')).toEqual([
      ...head,
      ...['-i', '/ws/a.mp4', '-map', '0:v:0', '-update', '1'],
      ...tail,
    ]);
  });

  it('contact sheet: same-sized stills tiled into one frame', () => {
    expect(
      buildContactSheetArgs({
        framesPattern: '/ws/.s/f-%03d.jpg',
        frameCount: 6,
        columns: 2,
        output: '/ws/sheet.jpg',
      }),
    ).toEqual([
      ...['-y', '-hide_banner', '-loglevel', 'error', '-framerate', '1'],
      ...['-i', '/ws/.s/f-%03d.jpg', '-vf', 'tile=2x3', '-frames:v', '1', '-q:v', '4'],
      '/ws/sheet.jpg',
    ]);
  });
});
