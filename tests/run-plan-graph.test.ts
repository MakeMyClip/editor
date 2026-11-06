import { describe, expect, it } from 'vitest';
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
