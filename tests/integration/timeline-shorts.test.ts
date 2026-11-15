import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTimeline } from '../../src/cli-timeline.js';
import { probe } from '../../src/ffmpeg/probe.js';
import { listFilters, runFfmpeg } from '../../src/ffmpeg/run.js';
import { readComposition } from '../../src/timeline/document-store.js';
import type { Transcript } from '../../src/timeline/transcript.js';

// A short cut from a 10-minute recording, end to end through the CLI: the
// source's cuts carry in, the export is 9:16 at -14 LUFS, main is untouched and
// one undo takes the short away. The transcript is a fixture, so no whisper.
const IS_CI = process.env.CI === 'true';
// CI's FFmpeg build has no drawtext, so captions are burned in only where it does.
const HAS_DRAWTEXT = IS_CI && (await listFilters()).has('drawtext');

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-shorts-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

/** Run a `clip timeline` subcommand and parse the JSON it prints. */
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

/** Integrated loudness of a file, LUFS, measured by ebur128. */
async function integratedLufs(path: string): Promise<number> {
  const { stderr } = await runFfmpeg([
    ...['-hide_banner', '-nostats', '-i', path, '-map', '0:a:0'],
    ...['-af', 'ebur128', '-f', 'null', '-'],
  ]);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const match = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  if (!match?.[1]) throw new Error(`No integrated loudness in:\n${summary}`);
  return Number(match[1]);
}

/** 10 minutes of 720p30 test pattern over a quiet tone stepping between two
 *  levels (about -26 LUFS), with a 2 s GOP: a 30 s piece looped by stream copy,
 *  which takes seconds instead of minutes to make. */
async function tenMinuteRecording(path: string): Promise<void> {
  const piece = join(workspace, 'piece.mp4');
  await runFfmpeg([
    ...['-hide_banner', '-loglevel', 'error'],
    ...['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=30'],
    ...['-f', 'lavfi', '-i', "aevalsrc='(0.05+0.05*lt(mod(t,4),2))*sin(2*PI*220*t)':s=48000:d=30"],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p'],
    ...['-c:a', 'aac', '-shortest', piece],
  ]);
  await runFfmpeg([
    ...['-hide_banner', '-loglevel', 'error'],
    ...['-stream_loop', '19', '-i', piece, '-c', 'copy', path],
  ]);
}

/** Word i spoken from i+0.2 s to i+0.7 s, as whisper would store it. */
async function storeTranscript(mediaId: string, source: string): Promise<void> {
  const file = await stat(source);
  const transcript: Transcript = {
    version: 1,
    mediaId: mediaId as Transcript['mediaId'],
    language: 'en',
    source: 'whisper-cpp',
    model: 'fixture',
    modelKey: 'fixture',
    requestedLanguage: 'auto',
    sourceSize: file.size,
    sourceMtimeMs: file.mtimeMs,
    words: Array.from({ length: 599 }, (_, i) => ({
      text: i % 8 === 7 ? `word${i}.` : `word${i}`,
      startSec: i + 0.2,
      endSec: i + 0.7,
    })),
  };
  await mkdir(join(workspace, 'transcripts'), { recursive: true });
  await writeFile(join(workspace, 'transcripts', `${mediaId}.json`), JSON.stringify(transcript));
}

describe.skipIf(!IS_CI)('shorts against real FFmpeg', () => {
  it('cuts a 9:16 short at -14 LUFS from a 10-minute recording, leaving main alone', async () => {
    const source = join(workspace, 'podcast.mp4');
    await tenMinuteRecording(source);
    await cli(['new', '--width', '1280', '--height', '720']);
    const added = await cli<{ clipId: string; mediaId: string }>(['add-media', source]);
    await storeTranscript(added.mediaId, source);
    // A retake cut on main (words 545..547) carries into the short.
    await cli(['cut-words', added.clipId, '545', '547']);
    const main = await readComposition();

    const short = await cli<{
      durationSec: number;
      pieces: { sourceInSec: number; sourceOutSec: number }[];
      canvas: { width: number; height: number; fit: string };
      captions: number;
      rev: number;
    }>([
      'short',
      'best-1',
      ...[added.clipId, '540', '552'],
      ...[added.clipId, '100', '105'],
      ...['--x', '0.3'],
      ...(HAS_DRAWTEXT ? [] : ['--no-captions']),
    ]);
    expect(short.pieces).toEqual([
      expect.objectContaining({ sourceInSec: 539.95, sourceOutSec: 545.2 }),
      expect.objectContaining({ sourceInSec: 547.7, sourceOutSec: 552.7 }),
      expect.objectContaining({ sourceInSec: 99.95, sourceOutSec: 105.7 }),
    ]);
    expect(short.durationSec).toBe(16);
    expect(short.canvas).toEqual({ width: 720, height: 1280, fit: 'cover' });
    if (HAS_DRAWTEXT) expect(short.captions).toBeGreaterThan(0);

    const output = join(workspace, 'best-1.mp4');
    const exported = await cli<{ loudness: { mode: string } }>([
      ...['--timeline', 'best-1', 'export', output],
    ]);
    expect(exported.loudness.mode).not.toBe('skipped');
    const probed = await probe(output);
    expect(probed.video).toMatchObject({ width: 720, height: 1280 });
    // Each piece is its own segment, which export rounds up to a whole video
    // frame (and AAC frame): up to one frame per piece, plus one AAC frame.
    const slack = short.pieces.length / 30 + 1024 / 48000;
    expect(Math.abs(probed.durationSec - short.durationSec)).toBeLessThanOrEqual(slack);
    expect(Math.abs((await integratedLufs(output)) + 14)).toBeLessThan(1);

    expect(await readComposition()).toEqual(main);
    const listed = await cli<{ timelines: { id: string }[] }>(['list']);
    expect(listed.timelines.map((t) => t.id)).toEqual(['main', 'best-1']);

    const undo = await cli<{ undone: boolean }>(['--timeline', 'best-1', 'undo']);
    expect(undo.undone).toBe(true);
    const emptied = await cli<{ tracks: unknown[] }>(['--timeline', 'best-1', 'show']);
    expect(emptied.tracks).toEqual([]);
    expect((await readComposition()).rev).toBe(main.rev);
  }, 240_000);
});
