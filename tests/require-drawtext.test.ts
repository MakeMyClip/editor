import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFilterList } from '../src/ffmpeg/run.js';
import type { FfmpegPlan } from '../src/timeline/compile.js';

const LIST_ARGS = ['-hide_banner', '-filters'];

// Rows as FFmpeg 6/7 print them, legend included.
const LIST_WITHOUT_DRAWTEXT = [
  'Filters:',
  '  T.. = Timeline support',
  '  A = Audio input/output',
  '  | = Source or sink filter',
  ' ..C color             |->V       Provide an uniformly colored input.',
  ' TSC scale             V->V       Scale the input video size and/or convert the image format.',
  ' ... nullsink          V->|       Do absolutely nothing with the input video.',
  ' ..C movie             |->N       Read from a movie source.',
  '',
].join('\n');
const LIST_WITH_DRAWTEXT = `${LIST_WITHOUT_DRAWTEXT} T.C drawtext          V->V       Draw text on top of video frames using libfreetype library.\n`;

describe('parseFilterList', () => {
  it('reads filter names and skips the legend', () => {
    expect(parseFilterList(LIST_WITH_DRAWTEXT)).toEqual(
      new Set(['color', 'scale', 'nullsink', 'movie', 'drawtext']),
    );
  });
});

// A stand-in FFmpeg that records each argv as a JSON line, prints `filterList`
// when asked for filters, and otherwise succeeds without writing anything.
async function installFakeFfmpeg(dir: string, filterList: string): Promise<string> {
  const bin = join(dir, 'ffmpeg');
  await writeFile(
    bin,
    [
      '#!/usr/bin/env node',
      "const { appendFileSync } = require('node:fs');",
      `appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      `if (process.argv.includes('-filters')) process.stdout.write(${JSON.stringify(filterList)});`,
      '',
    ].join('\n'),
  );
  await chmod(bin, 0o755);
  return bin;
}

describe.skipIf(process.platform === 'win32')('requireDrawtext', () => {
  let dir: string;
  const saved = {
    ffmpeg: process.env.MAKEMYCLIP_FFMPEG_PATH,
    workspace: process.env.MAKEMYCLIP_WORKSPACE,
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mmc-drawtext-'));
    process.env.MAKEMYCLIP_WORKSPACE = join(dir, 'workspace');
    // run.ts resolves the binary and caches the filter list at module scope.
    vi.resetModules();
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['MAKEMYCLIP_FFMPEG_PATH', saved.ffmpeg],
      ['MAKEMYCLIP_WORKSPACE', saved.workspace],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function load(filterList: string) {
    const bin = await installFakeFfmpeg(dir, filterList);
    process.env.MAKEMYCLIP_FFMPEG_PATH = bin;
    const { MissingFilterError } = await import('../src/ffmpeg/run.js');
    const { addText } = await import('../src/tools/add-text.js');
    const { addCaptions } = await import('../src/tools/add-captions.js');
    const { addTitleCard } = await import('../src/tools/add-title-card.js');
    const { runPlan } = await import('../src/timeline/run-plan.js');
    const calls = async (): Promise<string[][]> => {
      const log = await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '');
      return log
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    };
    return { bin, MissingFilterError, addText, addCaptions, addTitleCard, runPlan, calls };
  }

  function plan(textFiles: FfmpegPlan['steps'][number]['textFiles']): FfmpegPlan {
    const output = join(dir, 'out.mp4');
    const args = ['-y', '-f', 'lavfi', '-i', 'color=c=black', output];
    return { steps: [{ label: 'segment:a', args, output, textFiles }], output, durationSec: 1 };
  }

  it('stops every text path before it renders, listing filters once', async () => {
    const { bin, MissingFilterError, addText, addCaptions, addTitleCard, runPlan, calls } =
      await load(LIST_WITHOUT_DRAWTEXT);
    const missing = {
      name: 'MissingFilterError',
      filter: 'drawtext',
      ffmpegPath: bin,
      message: expect.stringContaining('MAKEMYCLIP_FFMPEG_PATH'),
    };
    const textfile = join(dir, 'title.txt');

    await expect(addText({ input: 'in.mp4', text: 'Hi', startSec: 0, endSec: 1 })).rejects.toThrow(
      MissingFilterError,
    );
    await expect(
      addCaptions({ input: 'in.mp4', cues: [{ text: 'Hi', startSec: 0, endSec: 1 }] }),
    ).rejects.toMatchObject(missing);
    await expect(addTitleCard({ input: 'in.mp4', text: 'Title' })).rejects.toMatchObject(missing);
    await expect(runPlan(plan([{ path: textfile, content: 'Hi' }]))).rejects.toMatchObject(missing);

    expect(await calls()).toEqual([LIST_ARGS]);
    expect(existsSync(textfile)).toBe(false);
  });

  it('leaves plans without text alone', async () => {
    const { runPlan, calls } = await load(LIST_WITHOUT_DRAWTEXT);
    const noText = plan([]);

    await runPlan(noText);

    expect(await calls()).toEqual([noText.steps[0]?.args]);
  });

  it('renders text when the filter is there', async () => {
    const { addText, calls } = await load(LIST_WITH_DRAWTEXT);

    await addText({ input: 'in.mp4', text: 'Hi', startSec: 0, endSec: 1 });

    const [listing, render] = await calls();
    expect(listing).toEqual(LIST_ARGS);
    expect(render?.slice(0, 4)).toEqual(['-y', '-i', join(process.cwd(), 'in.mp4'), '-vf']);
  });
});
