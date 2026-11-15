import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveFfmpeg, runFfmpeg } from '../../src/ffmpeg/run.js';
import { compileTimeline } from '../../src/timeline/compile.js';
import { emptyComposition } from '../../src/timeline/composition.js';
import { applyOps, mediaClip, videoTrack } from '../../src/timeline/ops.js';
import { runPlan } from '../../src/timeline/run-plan.js';
import type { MediaId } from '../../src/timeline/schema.js';

// Unit tests assert the afade args; this checks the exported audio actually
// comes down to near zero at a cut between two loud, out-of-phase windows.
const IS_CI = process.env.CI === 'true';
const RATE = 48000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mmc-join-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The first audio stream of a file as mono float samples. */
function samples(path: string): Float32Array {
  // The FFmpeg the export ran (env, bundled or system), so decoding can't miss it.
  const raw = execFileSync(
    resolveFfmpeg().path,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-f',
      'f32le',
      '-',
    ],
    { maxBuffer: 1 << 26 },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function rms(pcm: Float32Array, fromSec: number, toSec: number): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.round(fromSec * RATE); i < Math.round(toSec * RATE); i++) {
    sum += (pcm[i] ?? 0) ** 2;
    n++;
  }
  return Math.sqrt(sum / n);
}

describe.skipIf(!IS_CI)('join fades against real FFmpeg', () => {
  it('brings a continuous tone down to near zero at a hard cut', async () => {
    const source = join(dir, 'tone.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=3'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source],
    ]);
    const M = 'm_aaaaaaaaaaaa' as MediaId;
    // A cut at 1s into a window starting off-phase: without fades the
    // waveform jumps there, which is the click.
    const doc = applyOps(emptyComposition({ width: 160, height: 120 }), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M, sourceInSec: 0, sourceOutSec: 1, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({
          id: 'b',
          mediaId: M,
          sourceInSec: 1.5011,
          sourceOutSec: 2.5011,
          startSec: 1,
        }),
      },
    ]);
    const output = join(dir, 'cut.mp4');
    const media = new Map([[M, { path: source, hasAudio: true }]]);
    await runPlan(compileTimeline(doc, { media, dir, output }));

    const pcm = samples(output);
    const steady = rms(pcm, 0.9, 0.95);
    // Measured on FFmpeg 6.0: about 0.11 with the fades, 0.74 without.
    expect(rms(pcm, 0.998, 1.002) / steady).toBeLessThan(0.3);
    // The fade is short: 20 ms after the cut the tone is back at full level.
    expect(rms(pcm, 1.02, 1.07) / steady).toBeGreaterThan(0.9);
  }, 60_000);
});
