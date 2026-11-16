import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTimeline } from '../../src/cli-timeline.js';
import { probe } from '../../src/ffmpeg/probe.js';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import type { TimelineExport } from '../../src/timeline/run-plan.js';

// `clip timeline export --all` renders every short, each in its own shape and
// at its own loudness, and leaves main out.
const IS_CI = process.env.CI === 'true';

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-export-all-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

async function cli<T = Record<string, unknown>>(args: string[]): Promise<T> {
  let printed = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed += String(chunk);
    return true;
  });
  try {
    await runTimeline(args);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(printed) as T;
}

describe.skipIf(!IS_CI)('export --all against real FFmpeg', () => {
  it('renders each short in its own shape at -14 LUFS, and reports the one that cannot', async () => {
    const source = join(workspace, 'talk.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=6'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6'],
      ...['-af', 'volume=0.05', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      ...['-c:a', 'aac', '-shortest', source],
    ]);
    await cli(['add-media', source]);
    for (const [id, width, height, from, to] of [
      ['best-1', '1080', '1920', '0', '2'],
      ['best-2', '1080', '1080', '3', '5'],
    ] as const) {
      await cli(['--timeline', id, 'new', '--width', width, '--height', height, '--fit', 'cover']);
      await cli(['--timeline', id, 'add-media', source, from, to]);
      await cli(['--timeline', id, 'loudness', '-14']);
    }
    await cli(['--timeline', 'empty', 'new']);

    const dir = join(workspace, 'shorts');
    const { exported } = await cli<{ exported: TimelineExport[] }>(['export', '--all', dir]);
    expect(process.exitCode).toBe(1);
    expect(exported.map((e) => e.timeline)).toEqual(['best-1', 'best-2', 'empty']);
    expect(exported[2]).toEqual({
      timeline: 'empty',
      error: 'Nothing to export: no video track has clips.',
    });

    for (const [i, [width, height]] of [
      [1080, 1920],
      [1080, 1080],
    ].entries()) {
      const result = exported[i];
      if (!result || 'error' in result) throw new Error(`short ${i} failed: ${result?.error}`);
      expect(result.output).toBe(join(dir, `best-${i + 1}.mp4`));
      const media = await probe(result.output);
      expect([media.video?.width, media.video?.height]).toEqual([width, height]);
      expect(media.durationSec).toBeCloseTo(2, 0);
      expect(result.loudness?.outputLufs).toBeGreaterThan(-15);
      expect(result.loudness?.outputLufs).toBeLessThan(-13);
    }
  }, 60_000);
});
