import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { measureSpeechLevels, pauseAt } from '../../src/timeline/pauses.js';

// The levels a short's edges are placed by, measured by real FFmpeg on an
// encoded file: a tone sounding 0.1–0.7 s of every second, over quiet noise.
const IS_CI = process.env.CI === 'true';

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-pauses-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe.skipIf(!IS_CI)('pauses against real FFmpeg', () => {
  it('finds the pause a late transcript boundary points at, inside the real one', async () => {
    const source = join(workspace, 'talk.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=8'],
      ...[
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='0.3*sin(2*PI*220*t)*between(mod(t,1),0.1,0.7)+0.001*(random(0)-0.5)':s=48000:d=8",
      ],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      ...['-c:a', 'aac', '-shortest', source],
    ]);

    // "Speech" stops at 3.7 and starts again at 4.1; a transcript running
    // 0.25 s late puts the boundary at 4.35, its last word from 3.35.
    const levels = await measureSpeechLevels(source, 4.35);
    const pause = pauseAt(levels, 4.35, 3.35);
    if (typeof pause !== 'object') throw new Error(`no pause found: ${pause}`);
    // Inside the real pause, by at most 40 ms (AAC smears a sharp ending by
    // about 30 ms): a cut placed from it never moves toward the speech.
    expect(pause.startSec).toBeGreaterThanOrEqual(3.7 - 1e-6);
    expect(pause.startSec).toBeLessThanOrEqual(3.74);
    expect(pause.endSec).toBeLessThanOrEqual(4.1 + 1e-6);
    expect(pause.endSec).toBeGreaterThanOrEqual(4.06);

    // Audio that starts a second into the file: the levels still count from
    // the seek point, so the pause lands where it is (1.7–2.1), not 0.15 s early.
    const late = join(workspace, 'late.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=8'],
      ...['-itsoffset', '1'],
      ...[
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='0.3*sin(2*PI*220*t)*between(mod(t,1),0.1,0.7)+0.001*(random(0)-0.5)':s=48000:d=7",
      ],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      ...['-c:a', 'aac', late],
    ]);
    const shifted = pauseAt(await measureSpeechLevels(late, 2.35), 2.35, 1.35);
    if (typeof shifted !== 'object') throw new Error(`no pause found: ${shifted}`);
    expect(shifted.startSec).toBeGreaterThanOrEqual(1.7 - 1e-6);
    expect(shifted.startSec).toBeLessThanOrEqual(1.74);
    expect(shifted.endSec).toBeLessThanOrEqual(2.1 + 1e-6);
    expect(shifted.endSec).toBeGreaterThanOrEqual(2.06);

    // Where the tone never stops there is no pause to find.
    const steady = join(workspace, 'steady.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=4'],
      ...['-c:a', 'aac', steady],
    ]);
    expect(pauseAt(await measureSpeechLevels(steady, 2), 2, 1.5)).toBe('none');
  }, 60_000);
});
