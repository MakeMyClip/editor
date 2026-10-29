import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildAddTextArgs } from '../../src/ffmpeg/args/add-text.js';
import { buildConcatArgs } from '../../src/ffmpeg/args/concat.js';
import { quoteFilterArg } from '../../src/ffmpeg/escape.js';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildConcatListContent } from '../../src/tools/concat.js';

// The unit tests read escaped output back through a port of FFmpeg's parser;
// these run the real one. FFmpeg fails with "No such file" if a path comes out
// of either parse step changed.
const IS_CI = process.env.CI === 'true';
const QUIET = ['-hide_banner', '-loglevel', 'error'];
const SOURCE = ['-f', 'lavfi', '-i', 'color=c=black:s=96x64:r=10:d=0.2'];
const NAMES = [
  'plain',
  "O'Brien, [notes]; v1",
  process.platform === 'win32' ? 'no colon on windows' : 'drive:path',
  'trailing space ',
  String.raw`back\slash'quote`,
];

// `movie` ships in every FFmpeg build; drawtext needs libfreetype, which the
// Linux ffmpeg-static binary leaves out, so it only runs where it exists.
const filters = IS_CI ? await listFilters() : new Set<string>();

async function listFilters(): Promise<Set<string>> {
  const { stdout } = await runFfmpeg(['-hide_banner', '-filters']);
  return new Set([...stdout.matchAll(/^ \S{3} (\S+)\s+\S+->\S+/gm)].map((m) => m[1] as string));
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'makemyclip-escape-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeClip(path: string): Promise<void> {
  await runFfmpeg([
    ...QUIET,
    ...SOURCE,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'mp4',
    path,
  ]);
}

describe.skipIf(!IS_CI)('path escaping against real FFmpeg', () => {
  it.each(NAMES)('the movie filter opens %j', async (name) => {
    await withTempDir(async (dir) => {
      const clip = join(dir, name);
      await writeClip(clip);
      const graph = `movie=filename=${quoteFilterArg(clip)}`;
      await runFfmpeg([...QUIET, '-f', 'lavfi', '-i', graph, '-frames:v', '1', '-f', 'null', '-']);
    });
  });

  describe.skipIf(!filters.has('drawtext'))('drawtext', () => {
    it.each(NAMES)('reads textfile %j', async (name) => {
      await withTempDir(async (dir) => {
        const textfile = join(dir, name);
        await writeFile(textfile, 'Visible text', 'utf8');
        const filter = buildAddTextArgs({
          input: 'unused',
          output: 'unused',
          textfile,
          position: 'center',
          startSec: 0,
          endSec: 1,
          fontSize: 16,
          box: false,
        })[4] as string;
        await runFfmpeg([...QUIET, ...SOURCE, '-vf', filter, '-frames:v', '1', '-f', 'null', '-']);
      });
    });
  });

  it('the concat demuxer reads a list with quotes, commas and brackets in the name', async () => {
    await withTempDir(async (dir) => {
      const clip = join(dir, "O'Brien, [clip]; take 2.mp4");
      const listFile = join(dir, 'list.txt');
      await writeClip(clip);
      await writeFile(listFile, buildConcatListContent([clip, clip]), 'utf8');
      await runFfmpeg(buildConcatArgs({ listFile, output: join(dir, 'joined.mp4') }));
    });
  });
});
