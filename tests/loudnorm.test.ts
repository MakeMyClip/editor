import { describe, expect, it } from 'vitest';
import {
  buildLoudnormApplyArgs,
  buildLoudnormMeasureArgs,
  type LoudnormMeasurement,
  parseLoudnormJson,
} from '../src/ffmpeg/args/loudnorm.js';

const BLOCK = `{
\t"input_i" : "-26.44",
\t"input_tp" : "-23.01",
\t"input_lra" : "2.00",
\t"input_thresh" : "-36.44",
\t"output_i" : "-14.79",
\t"output_tp" : "-11.82",
\t"output_lra" : "1.80",
\t"output_thresh" : "-24.79",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.79"
}`;

// The tail of a measure pass as each FFmpeg prints it.
const FFMPEG_6 = [
  '      encoder         : Lavc60.3.100 pcm_s16le',
  'video:0kB audio:3000kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: unknown',
  '[Parsed_loudnorm_0 @ 0x129805750] ',
  BLOCK,
  '',
].join('\n');
const FFMPEG_7 = [
  '        encoder         : Lavc61.19.101 pcm_s16le',
  '[Parsed_loudnorm_0 @ 0x7c102e340] ',
  BLOCK,
  '[out#0/null @ 0x7c102dec0] video:0KiB audio:3000KiB subtitle:0KiB other streams:0KiB',
  'size=N/A time=00:00:04.00 bitrate=N/A speed=36.1x',
].join('\n');

const MEASURED: LoudnormMeasurement = {
  inputI: -26.44,
  inputTp: -23.01,
  inputLra: 2,
  inputThresh: -36.44,
  targetOffset: 0.79,
  outputI: -14.79,
  outputTp: -11.82,
  mode: 'dynamic',
};

describe('parseLoudnormJson', () => {
  it('reads the block wherever FFmpeg 6 or 7 prints it', () => {
    expect(parseLoudnormJson(FFMPEG_6)).toEqual(MEASURED);
    expect(parseLoudnormJson(FFMPEG_7)).toEqual(MEASURED);
  });

  it('reads the normalization type of an apply pass', () => {
    const linear = FFMPEG_7.replace('"dynamic"', '"linear"');
    expect(parseLoudnormJson(linear)?.mode).toBe('linear');
  });

  it('returns null for silent audio and for stderr without a block', () => {
    const silent = FFMPEG_6.replace('"-26.44"', '"-inf"').replace('"0.79"', '"inf"');
    expect(parseLoudnormJson(silent)).toBeNull();
    expect(parseLoudnormJson('Output #0, null, to "pipe:":\nsize=N/A')).toBeNull();
  });
});

describe('loudnorm args', () => {
  it('measures the first audio stream into the null muxer', () => {
    expect(buildLoudnormMeasureArgs({ input: '/ws/out.mp4', targetLufs: -14 })).toEqual([
      '-hide_banner',
      '-nostats',
      '-i',
      '/ws/out.mp4',
      '-map',
      '0:a:0',
      '-af',
      'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
      '-f',
      'null',
      '-',
    ]);
  });

  it('applies the measured values in linear mode, copying the video', () => {
    expect(
      buildLoudnormApplyArgs({
        input: '/ws/out.mp4',
        output: '/ws/.loudnorm-1.mp4',
        targetLufs: -16,
        measured: MEASURED,
      }),
    ).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      '/ws/out.mp4',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-26.44:measured_TP=-23.01:measured_LRA=2:measured_thresh=-36.44:offset=0.79:linear=true:print_format=json',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '/ws/.loudnorm-1.mp4',
    ]);
  });

  it('keeps the range target of the measure pass, whatever range was measured', () => {
    const lra = (inputLra: number): string | undefined =>
      buildLoudnormApplyArgs({
        input: 'a.mp4',
        output: 'b.mp4',
        targetLufs: -14,
        measured: { ...MEASURED, inputLra },
      })
        .find((a) => a.startsWith('loudnorm='))
        ?.split(':')
        .find((p) => p.startsWith('LRA='));
    expect(lra(14.2)).toBe('LRA=11');
    expect(lra(80)).toBe('LRA=11');
  });
});
