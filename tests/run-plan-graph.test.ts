import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFfmpegMajor } from '../src/ffmpeg/run.js';
import { INLINE_GRAPH_MAX, spillLongGraph } from '../src/timeline/run-plan.js';

describe('parseFfmpegMajor', () => {
  it('reads release, tagged and unnamed builds', () => {
    expect(parseFfmpegMajor('ffmpeg version 6.0 Copyright (c) 2000-2023')).toBe(6);
    expect(parseFfmpegMajor('ffmpeg version n7.0.2-static https://johnvansickle.com')).toBe(7);
    expect(parseFfmpegMajor('ffmpeg version 7.1.1 Copyright (c) 2000-2025')).toBe(7);
    expect(parseFfmpegMajor('ffmpeg version N-118000-g1234abcd Copyright')).toBeNull();
  });
});

describe('spillLongGraph', () => {
  const args = (graph: string) => ['-y', '-i', 'in.mp4', '-filter_complex', graph, 'out.mp4'];

  it('keeps a short graph inline', () => {
    const short = args('[0:v]null[v]');
    expect(spillLongGraph(short, '/ws/g.txt', '-/filter_complex')).toEqual({
      args: short,
      graph: null,
    });
  });

  it('moves a long graph to the file option', () => {
    const graph = `[0:v]${'drawtext=text=x,'.repeat(INLINE_GRAPH_MAX / 10)}null[v]`;
    const spilled = spillLongGraph(args(graph), '/ws/g.txt', '-filter_complex_script');
    expect(spilled.graph).toBe(graph);
    expect(spilled.args).toEqual([
      '-y',
      '-i',
      'in.mp4',
      '-filter_complex_script',
      '/ws/g.txt',
      'out.mp4',
    ]);
  });
});

describe.skipIf(process.platform === 'win32')('filterGraphFileOption', () => {
  const saved = process.env.MAKEMYCLIP_FFMPEG_PATH;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mmc-graph-option-'));
    vi.resetModules();
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.MAKEMYCLIP_FFMPEG_PATH;
    else process.env.MAKEMYCLIP_FFMPEG_PATH = saved;
    await rm(dir, { recursive: true, force: true });
  });

  /** A fake FFmpeg printing `version` for -version and `help` for -h full. */
  async function option(version: string, help: string): Promise<string> {
    const bin = join(dir, 'ffmpeg');
    await writeFile(
      bin,
      `#!/bin/sh\nfor a in "$@"; do\n  [ "$a" = -version ] && { echo '${version}'; exit 0; }\n  [ "$a" = full ] && { echo '${help}'; exit 0; }\ndone\n`,
    );
    await chmod(bin, 0o755);
    process.env.MAKEMYCLIP_FFMPEG_PATH = bin;
    const { filterGraphFileOption } = await import('../src/ffmpeg/run.js');
    return filterGraphFileOption();
  }

  it('picks by version, and by the help text when the build has none', async () => {
    expect(await option('ffmpeg version 6.1.1', '')).toBe('-filter_complex_script');
    vi.resetModules();
    expect(await option('ffmpeg version 7.1.1', '')).toBe('-/filter_complex');
    vi.resetModules();
    expect(await option('ffmpeg version N-1-gabc', '-filter_complex_script <file>')).toBe(
      '-filter_complex_script',
    );
    vi.resetModules();
    expect(await option('ffmpeg version N-1-gabc', '-filter_complex <graph>')).toBe(
      '-/filter_complex',
    );
  });
});
