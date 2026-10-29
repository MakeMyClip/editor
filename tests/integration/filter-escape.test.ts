import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildAddTextArgs } from '../../src/ffmpeg/args/add-text.js';
import { buildConcatArgs } from '../../src/ffmpeg/args/concat.js';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildConcatListContent } from '../../src/tools/concat.js';

// The unit tests read escaped output back through a port of FFmpeg's parser;
// these run the real one. FFmpeg fails with "No such file" if a path comes out
// of either parse step changed.
const SOURCE = ['-f', 'lavfi', '-i', 'color=c=black:s=96x64:r=10:d=0.2'];

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'makemyclip-escape-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.CI !== 'true')('path escaping against real FFmpeg', () => {
  it.each([
    'plain.txt',
    "O'Brien, [notes]; v1.txt",
    process.platform === 'win32' ? 'no colon on windows.txt' : 'drive:path.txt',
    'trailing space.txt ',
    String.raw`back\slash'quote.txt`,
  ])('drawtext reads textfile %j', async (name) => {
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
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        ...SOURCE,
        '-vf',
        filter,
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);
    });
  });

  it('the concat demuxer reads a list with quotes, commas and brackets in the name', async () => {
    await withTempDir(async (dir) => {
      const clip = join(dir, "O'Brien, [clip]; take 2.mp4");
      const listFile = join(dir, 'list.txt');
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        ...SOURCE,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        clip,
      ]);
      await writeFile(listFile, buildConcatListContent([clip, clip]), 'utf8');
      await runFfmpeg(buildConcatArgs({ listFile, output: join(dir, 'joined.mp4') }));
    });
  });
});
