import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTimeline } from '../../src/cli-timeline.js';
import { fallbackFontCandidates, fontFileFor, readCoverage } from '../../src/ffmpeg/font.js';
import { listFilters, runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { buildFrameAtPlan } from '../../src/timeline/compile.js';
import { readComposition } from '../../src/timeline/document-store.js';
import { buildMediaMap } from '../../src/timeline/media-registry.js';
import { runPlan } from '../../src/timeline/run-plan.js';
import type { Transcript } from '../../src/timeline/transcript.js';

// Captions burned in by real FFmpeg. A font without a glyph draws the same box
// (or nothing) for every character it lacks, so two different strings of the
// same length render identical frames; real glyphs render different ones.
const IS_CI = process.env.CI === 'true';
const filters = IS_CI ? await listFilters() : new Set<string>();
const ffmpegPath = (): string => process.env.MAKEMYCLIP_FFMPEG_PATH ?? ffmpegStatic ?? 'ffmpeg';

const hasFontFor = (text: string): boolean => {
  try {
    return fontFileFor(text) !== undefined;
  } catch {
    return false;
  }
};
/** An installed font that lacks the CJK test glyphs, for the control case. */
const NO_CJK_FONT = fallbackFontCandidates().find((path) => {
  try {
    const covers = readCoverage(path);
    return covers?.(0x410) === true && covers(0x4f60) === false;
  } catch {
    return false;
  }
});

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-captions-'));
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

async function sequence<T>(items: number[], run: (item: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (const item of items) out.push(await run(item));
  return out;
}

// Pixels that differ by more than encoding noise: two strings drawn as boxes
// differ in none, two drawn as real glyphs in hundreds (320x180 frames, 28 px text).
const BOXES_MATCH = 20;
const GLYPHS_DIFFER = 100;

function differingPixels(a: Buffer | undefined, b: Buffer | undefined): number {
  if (!a || !b || a.length !== b.length) throw new Error('frames differ in size');
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i] as number) - (b[i] as number)) > 40) count++;
  }
  return count;
}

/** The frame as raw gray pixels. */
async function pixels(image: string): Promise<Buffer> {
  const { stdout } = await execa(
    ffmpegPath(),
    ['-hide_banner', '-loglevel', 'error', '-i', image, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer' },
  );
  return Buffer.from(stdout);
}

async function blackClip(path: string, seconds: number): Promise<void> {
  await runFfmpeg([
    ...['-hide_banner', '-loglevel', 'error'],
    ...['-f', 'lavfi', '-i', `color=c=black:s=320x180:r=10:d=${seconds}`],
    ...['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(seconds), path],
  ]);
}

/** A stored transcript for the timeline's only clip, as whisper would leave it. */
async function storeTranscript(words: Transcript['words']): Promise<void> {
  const comp = await readComposition();
  const clip = comp.tracks[0]?.clips[0];
  if (clip?.kind !== 'media') throw new Error('expected a media clip');
  const info = (await buildMediaMap()).get(clip.mediaId);
  if (!info) throw new Error('media not registered');
  const source = await stat(info.path);
  const transcript: Transcript = {
    version: 1,
    mediaId: clip.mediaId,
    language: null,
    source: 'whisper-cpp',
    model: 'fixture',
    modelKey: 'fixture',
    requestedLanguage: 'auto',
    sourceSize: source.size,
    sourceMtimeMs: source.mtimeMs,
    words,
  };
  await mkdir(join(workspace, 'transcripts'), { recursive: true });
  await writeFile(
    join(workspace, 'transcripts', `${clip.mediaId}.json`),
    JSON.stringify(transcript),
  );
}

const WORDS = [
  { text: 'Привет', startSec: 0.2, endSec: 0.6 },
  { text: 'Москва', startSec: 1.2, endSec: 1.6 },
  { text: '你好', startSec: 2.2, endSec: 2.6 },
  { text: '世界', startSec: 3.2, endSec: 3.6 },
];

describe.skipIf(!IS_CI || !filters.has('drawtext'))(
  'captions against real FFmpeg',
  { timeout: 60_000 },
  () => {
    it.skipIf(!hasFontFor('Привет 你好'))(
      'captions Cyrillic and CJK speech through the CLI and draws real glyphs',
      async () => {
        await blackClip(join(workspace, 'talk.mp4'), 4);
        await cli(['new', '--width', '320', '--height', '180', '--fps', '10']);
        await cli(['add-media', join(workspace, 'talk.mp4')]);
        await storeTranscript(WORDS);

        expect(await cli(['captions', '--words', '1', '--dry-run'])).toMatchObject({
          captions: 4,
          applied: false,
        });
        expect(await cli(['captions', '--words', '1', '--font', '28'])).toMatchObject({
          captions: 4,
          applied: true,
        });
        const show = await cli<{ exportable: boolean; tracks: { id: string; clips: unknown[] }[] }>(
          ['show'],
        );
        expect(show.exportable).toBe(true);
        expect(show.tracks.map((t) => [t.id, t.clips.length])).toEqual([
          ['v0', 1],
          ['captions', 4],
        ]);

        const frame = async (atSec: number): Promise<Buffer> => {
          const out = join(workspace, `f-${atSec}.png`);
          await cli(['frame', String(atSec), out]);
          return pixels(out);
        };
        const [blank, privet, moskva, nihao, shijie] = await sequence(
          [1.1, 0.5, 1.4, 2.4, 3.4],
          frame,
        );
        for (const drawn of [privet, moskva, nihao, shijie]) {
          expect(differingPixels(drawn, blank)).toBeGreaterThan(GLYPHS_DIFFER);
        }
        expect(differingPixels(privet, moskva)).toBeGreaterThan(GLYPHS_DIFFER);
        expect(differingPixels(nihao, shijie)).toBeGreaterThan(GLYPHS_DIFFER);

        const exported = await cli<{ exported: string }>(['export', join(workspace, 'out.mp4')]);
        expect((await stat(exported.exported)).size).toBeGreaterThan(0);
      },
    );

    it('renders a clip with hundreds of captions, its graph read from a file', async () => {
      await blackClip(join(workspace, 'talk.mp4'), 4);
      await cli(['new', '--width', '320', '--height', '180', '--fps', '10']);
      await cli(['add-media', join(workspace, 'talk.mp4')]);
      await storeTranscript(
        Array.from({ length: 400 }, (_, i) => ({
          text: `w${i}`,
          startSec: i / 100,
          endSec: i / 100 + 0.009,
        })),
      );
      expect(await cli(['captions', '--words', '1', '--font', '28'])).toMatchObject({
        captions: 400,
      });
      const frame = async (atSec: number): Promise<Buffer> => {
        const out = join(workspace, `many-${atSec}.png`);
        await cli(['frame', String(atSec), out]);
        return pixels(out);
      };
      expect(differingPixels(await frame(1.005), await frame(2.005))).toBeGreaterThan(
        GLYPHS_DIFFER,
      );
    });

    it.skipIf(!NO_CJK_FONT)(
      'tells boxes from glyphs: a font without CJK draws 你好 and 世界 alike',
      async () => {
        await blackClip(join(workspace, 'talk.mp4'), 4);
        await cli(['new', '--width', '320', '--height', '180', '--fps', '10']);
        await cli(['add-media', join(workspace, 'talk.mp4')]);
        await storeTranscript(WORDS);
        await cli(['captions', '--words', '1', '--font', '28']);
        const comp = await readComposition();
        const media = await buildMediaMap();
        const frame = async (atSec: number): Promise<Buffer> => {
          const output = join(workspace, `boxes-${atSec}.png`);
          await runPlan(
            buildFrameAtPlan(
              comp,
              { media, dir: workspace, output, fontFor: () => NO_CJK_FONT },
              atSec,
            ),
          );
          return pixels(output);
        };
        const [nihao, shijie] = await sequence([2.4, 3.4], frame);
        expect(differingPixels(nihao, shijie)).toBeLessThan(BOXES_MATCH);
      },
    );
  },
);

// Real whisper.cpp on synthetic speech, end to end over MCP: transcribe,
// caption, see the frame, export.
const CAN_WHISPER =
  IS_CI &&
  filters.has('drawtext') &&
  Boolean(process.env.MAKEMYCLIP_WHISPER_MODEL) &&
  process.platform === 'darwin';

describe.skipIf(!CAN_WHISPER)(
  'captions from real whisper.cpp over MCP',
  { timeout: 90_000 },
  () => {
    it('captions a spoken clip as one undoable edit and exports it', async () => {
      const speech = join(workspace, 'speech.aiff');
      await execa('say', ['-o', speech, 'Hello there. This is a short caption test.']);
      const talk = join(workspace, 'talk.mp4');
      await runFfmpeg([
        ...['-hide_banner', '-loglevel', 'error'],
        ...['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10:d=5'],
        ...['-i', speech, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
        talk,
      ]);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = buildMcpServer();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(clientTransport);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        return result.content as { type: string; text?: string }[];
      };
      const json = <T>(content: { text?: string }[]): T =>
        JSON.parse(content[0]?.text ?? '{}') as T;
      try {
        await call('timeline_edit', { verbs: [{ verb: 'add_media', id: 'c', path: talk }] });
        const transcript = json<{ words: { text: string }[] }>(
          await call('timeline_transcript', { clipId: 'c' }),
        );
        expect(transcript.words.length).toBeGreaterThan(3);

        await call('timeline_edit', { verbs: [{ verb: 'caption_speech' }] });
        const comp = await readComposition();
        const captions = comp.tracks.find((t) => t.id === 'captions')?.clips ?? [];
        expect(captions.length).toBeGreaterThan(0);
        const said = captions.map((c) => (c.kind === 'text' ? c.text : '')).join(' ');
        expect(said.toLowerCase()).toContain('caption');

        const first = captions[0];
        const shown = await call('timeline_show', { atSec: (first?.startSec ?? 0) + 0.1 });
        expect(shown.some((c) => c.type === 'image')).toBe(true);

        const exported = json<{ exported?: string; error?: string }>(await call('timeline_export'));
        expect(exported.error).toBeUndefined();
        expect((await stat(exported.exported as string)).size).toBeGreaterThan(0);

        await call('timeline_undo');
        expect((await readComposition()).tracks.find((t) => t.id === 'captions')).toBeUndefined();
      } finally {
        await client.close();
        await server.close();
      }
    });
  },
);
