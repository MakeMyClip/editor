import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildAddTextArgs } from '../../src/ffmpeg/args/add-text.js';
import { buildConcatArgs } from '../../src/ffmpeg/args/concat.js';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildConcatListContent } from '../../src/tools/concat.js';

// The real parser catches errors that a string-unescaping simulation misses.
describe.skipIf(process.env.CI !== 'true')('filter option escaping with FFmpeg', () => {
  it.each([
    'plain note.txt',
    "O'Brien, [notes]; v1.txt",
    process.platform === 'win32' ? 'drive path.txt' : 'drive:path.txt',
  ])('reads the exact textfile %s', async (name) => {
    const dir = await mkdtemp(join(tmpdir(), 'makemyclip-escape-'));
    const textfile = join(dir, name);
    try {
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
      })[4];
      if (!filter) throw new Error('Missing drawtext filter');
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=96x64:r=10:d=0.2',
        '-vf',
        filter,
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);
    } finally {
      await unlink(textfile);
      await rmdir(dir);
    }
  });

  it('uses concat-list quoting without filter-option escapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'makemyclip-escape-'));
    const input = join(dir, "O'Brien, [clip];.mp4");
    const listFile = join(dir, 'list.txt');
    const output = join(dir, 'joined.mp4');
    try {
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=96x64:r=10:d=0.2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        input,
      ]);
      await writeFile(listFile, buildConcatListContent([input, input]), 'utf8');
      await runFfmpeg(buildConcatArgs({ listFile, output }));
    } finally {
      for (const file of [input, listFile, output]) {
        await unlink(file).catch(() => undefined);
      }
      await rmdir(dir);
    }
  });
});
