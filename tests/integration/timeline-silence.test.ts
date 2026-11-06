import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import type { MediaInfo } from '../../src/timeline/compile.js';
import { emptyComposition } from '../../src/timeline/composition.js';
import { applyOps, mediaClip, videoTrack } from '../../src/timeline/ops.js';
import type { MediaId } from '../../src/timeline/schema.js';
import { analyzeSilence, SilenceAnalysisError } from '../../src/timeline/silence.js';

// The unit tests feed captured silencedetect output; this runs the real filter
// over a TRIMMED clip, where window-relative times must be offset by the in point.
const IS_CI = process.env.CI === 'true';
const M = 'm_aaaaaaaaaaaa' as MediaId;

describe.skipIf(!IS_CI)('silence analysis against real FFmpeg', () => {
  it('finds the speech in a trimmed clip in source time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'makemyclip-silence-'));
    try {
      // 6s: a tone for the first 1.5s of every 3s, silence otherwise.
      const path = join(dir, 'pauses.mp4');
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=96x64:r=10:d=6',
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='if(lt(mod(t,3),1.5),0.5*sin(2*PI*440*t),0)':s=48000:d=6",
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        path,
      ]);
      const comp = applyOps(emptyComposition(), [
        { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
        {
          op: 'addClip',
          trackId: 'v0',
          clip: mediaClip({ id: 'c1', mediaId: M, sourceInSec: 1, sourceOutSec: 5, startSec: 0 }),
        },
      ]);
      const media = new Map<MediaId, MediaInfo>([[M, { path, hasAudio: true }]]);

      const cut = await analyzeSilence(comp, 'c1', { media, mintId: () => 'c1b' });

      // Sound at source [1,1.5) and [3,4.5), each padded by 0.1s.
      expect(cut.keepRegions).toHaveLength(2);
      expect(cut.keepRegions[0]?.sourceInSec).toBe(1);
      expect(cut.keepRegions[0]?.sourceOutSec).toBeCloseTo(1.6, 1);
      expect(cut.keepRegions[1]?.sourceInSec).toBeCloseTo(2.9, 1);
      expect(cut.keepRegions[1]?.sourceOutSec).toBeCloseTo(4.6, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats audio that ends before the video as silence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'makemyclip-silence-'));
    try {
      // 6s of video, 2s of tone.
      const path = join(dir, 'short-audio.mp4');
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=96x64:r=10:d=6',
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=2",
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        path,
      ]);
      const comp = applyOps(emptyComposition(), [
        { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
        {
          op: 'addClip',
          trackId: 'v0',
          clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 6, startSec: 0 }),
        },
      ]);
      const media = new Map<MediaId, MediaInfo>([[M, { path, hasAudio: true }]]);

      const cut = await analyzeSilence(comp, 'c1', { media });

      expect(cut.keepRegions).toHaveLength(1);
      expect(cut.keepRegions[0]?.sourceOutSec).toBeCloseTo(2.1, 1);

      // A window entirely past the end of the audio is all silence.
      const pastAudio = applyOps(emptyComposition(), [
        { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
        {
          op: 'addClip',
          trackId: 'v0',
          clip: mediaClip({ id: 'c1', mediaId: M, sourceInSec: 3, sourceOutSec: 6, startSec: 0 }),
        },
      ]);
      await expect(analyzeSilence(pastAudio, 'c1', { media })).rejects.toThrow(
        SilenceAnalysisError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps out-of-phase stereo and late-starting audio in source time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'makemyclip-silence-'));
    const video = ['-f', 'lavfi', '-i', 'color=c=black:s=96x64:r=10:d=6'];
    const encode = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
    const tone = '0.5*sin(2*PI*440*t)';
    const oneClip = (sourceOutSec: number) =>
      applyOps(emptyComposition(), [
        { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
        {
          op: 'addClip',
          trackId: 'v0',
          clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec, startSec: 0 }),
        },
      ]);
    try {
      // Right channel = -left: a mono downmix would cancel to silence.
      const antiphase = join(dir, 'antiphase.mp4');
      await runFfmpeg([
        ...['-hide_banner', '-loglevel', 'error', ...video],
        ...['-f', 'lavfi', '-i', `aevalsrc='${tone}|-${tone}':s=48000:d=6`, ...encode, antiphase],
      ]);
      const whole = await analyzeSilence(oneClip(6), 'c1', {
        media: new Map([[M, { path: antiphase, hasAudio: true }]]),
      });
      expect(whole.op).toBeNull();

      // 2s of tone whose timestamps start at 2s.
      const delayed = join(dir, 'delayed.mp4');
      await runFfmpeg([
        ...['-hide_banner', '-loglevel', 'error', ...video, '-itsoffset', '2'],
        ...['-f', 'lavfi', '-i', `aevalsrc='${tone}':s=48000:d=2`],
        ...['-map', '0:v', '-map', '1:a', ...encode, delayed],
      ]);
      const late = await analyzeSilence(oneClip(6), 'c1', {
        media: new Map([[M, { path: delayed, hasAudio: true }]]),
      });
      expect(late.keepRegions).toHaveLength(1);
      expect(late.keepRegions[0]?.sourceInSec).toBeCloseTo(1.9, 1);
      expect(late.keepRegions[0]?.sourceOutSec).toBeCloseTo(4.1, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
