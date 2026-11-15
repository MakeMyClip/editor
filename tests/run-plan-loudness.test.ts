import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FfmpegPlan } from '../src/timeline/compile.js';

// A stand-in FFmpeg: records each argv, writes "rendered" to a step's output,
// answers a loudnorm measure with `measure.json` on stderr, and writes
// "normalized" to an apply pass's output (or fails if `fail-apply` exists).
const FAKE = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = __dirname;
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const af = args[args.indexOf('-af') + 1] || '';
const out = args[args.length - 1];
if (af.startsWith('loudnorm=') && !af.includes('measured_I')) {
  process.stderr.write('[Parsed_loudnorm_0 @ 0x1] \\n' + readFileSync(join(dir, 'measure.json'), 'utf8'));
} else if (af.startsWith('loudnorm=')) {
  if (existsSync(join(dir, 'fail-apply'))) process.exit(1);
  writeFileSync(out, 'normalized');
  process.stderr.write('[Parsed_loudnorm_0 @ 0x1] \\n' + readFileSync(join(dir, 'measure.json'), 'utf8').replace('"dynamic"', '"linear"').replace('"-14.79"', '"-14.02"'));
} else {
  writeFileSync(out, 'rendered');
}
`;

const block = (inputI: string): string =>
  JSON.stringify(
    {
      input_i: inputI,
      input_tp: '-23.01',
      input_lra: '2.00',
      input_thresh: '-36.44',
      output_i: '-14.79',
      output_tp: '-11.82',
      output_lra: '1.80',
      output_thresh: '-24.79',
      normalization_type: 'dynamic',
      target_offset: '0.79',
    },
    null,
    '\t',
  );

describe.skipIf(process.platform === 'win32')('runPlan loudness pass', () => {
  let dir: string;
  const saved = process.env.MAKEMYCLIP_FFMPEG_PATH;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mmc-loudness-'));
    const bin = join(dir, 'ffmpeg');
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
    process.env.MAKEMYCLIP_FFMPEG_PATH = bin;
    vi.resetModules();
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.MAKEMYCLIP_FFMPEG_PATH;
    else process.env.MAKEMYCLIP_FFMPEG_PATH = saved;
    await rm(dir, { recursive: true, force: true });
  });

  function plan(): FfmpegPlan {
    const output = join(dir, 'out.mp4');
    return {
      steps: [{ label: 'segment:a', args: ['-y', '-i', 'in.mp4', output], output, textFiles: [] }],
      output,
      durationSec: 1,
      loudness: { targetLufs: -14 },
    };
  }

  async function run(inputI: string) {
    await writeFile(join(dir, 'measure.json'), block(inputI));
    const { runPlan } = await import('../src/timeline/run-plan.js');
    return runPlan(plan());
  }

  const calls = async (): Promise<string[][]> =>
    (await readFile(join(dir, 'calls.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

  it('measures the export, then rewrites it at the target', async () => {
    const result = await run('-26.44');
    expect(result.loudness).toEqual({
      targetLufs: -14,
      inputLufs: -26.44,
      outputLufs: -14.02,
      truePeakDb: -11.82,
      mode: 'linear',
    });
    expect(await readFile(join(dir, 'out.mp4'), 'utf8')).toBe('normalized');
    const [, measure, apply] = await calls();
    expect(measure?.slice(2, 4)).toEqual(['-i', join(dir, 'out.mp4')]);
    expect(apply?.at(-1)).toMatch(/\/\.loudnorm-[0-9a-f]{8}\.mp4$/);
    // The temp file was renamed over the export, nothing else left behind.
    expect((await readdir(dir)).filter((f) => f.startsWith('.loudnorm-'))).toEqual([]);
  });

  it('leaves silent and near-silent exports as they are', async () => {
    const silent = await run('-inf');
    expect(silent.loudness).toMatchObject({ mode: 'skipped', inputLufs: null, outputLufs: null });
    expect(await readFile(join(dir, 'out.mp4'), 'utf8')).toBe('rendered');
    expect(await calls()).toHaveLength(2);

    const quiet = await run('-61.5');
    expect(quiet.loudness).toMatchObject({ mode: 'skipped', inputLufs: -61.5 });
  });

  it('removes the export when normalizing fails, so it is never left looking done', async () => {
    await writeFile(join(dir, 'fail-apply'), '');
    await expect(run('-26.44')).rejects.toThrow();
    expect(existsSync(join(dir, 'out.mp4'))).toBe(false);
    expect((await readdir(dir)).filter((f) => f.startsWith('.loudnorm-'))).toEqual([]);
  });
});
