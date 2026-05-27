import { describe, expect, it } from 'vitest';
import { buildVidstabDetectArgs, buildVidstabTransformArgs } from '../src/ffmpeg/args/stabilize.js';
import { StabilizeInput } from '../src/tools/stabilize.js';

describe('buildVidstabDetectArgs', () => {
  const base = {
    input: 'in.mp4',
    transformsFile: '/tmp/transforms.trf',
    shakiness: 5,
    accuracy: 9,
  };

  it('uses vidstabdetect with result + shakiness + accuracy', () => {
    const args = buildVidstabDetectArgs(base);
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toBe('vidstabdetect=result=/tmp/transforms.trf:shakiness=5:accuracy=9');
  });

  it('discards output via -f null - (we only want the .trf)', () => {
    const args = buildVidstabDetectArgs(base);
    expect(args).toContain('-f');
    expect(args).toContain('null');
    expect(args.at(-1)).toBe('-');
  });

  it('skips audio decode (-an) — irrelevant to motion detection', () => {
    expect(buildVidstabDetectArgs(base)).toContain('-an');
  });
});

describe('buildVidstabTransformArgs', () => {
  const base = {
    input: 'in.mp4',
    output: 'out.mp4',
    transformsFile: '/tmp/transforms.trf',
    smoothing: 10,
    zoom: 5,
    hasAudio: true,
  };

  it('uses vidstabtransform with input + smoothing + zoom + unsharp follow-up', () => {
    const args = buildVidstabTransformArgs(base);
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toContain('vidstabtransform=input=/tmp/transforms.trf');
    expect(vf).toContain('smoothing=10');
    expect(vf).toContain('zoom=5');
    expect(vf).toContain('unsharp=5:5:0.8:3:3:0.4');
  });

  it('stream-copies audio when present', () => {
    const args = buildVidstabTransformArgs(base);
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
  });

  it('omits audio codec when no audio', () => {
    const args = buildVidstabTransformArgs({ ...base, hasAudio: false });
    expect(args).not.toContain('-c:a');
  });

  it('every arg is a discrete string (no shell interpolation)', () => {
    const args = buildVidstabTransformArgs(base);
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('StabilizeInput', () => {
  const valid = { input: 'shaky.mp4' };

  it('accepts minimal input', () => {
    expect(() => StabilizeInput.parse(valid)).not.toThrow();
  });

  it('applies sensible defaults', () => {
    const parsed = StabilizeInput.parse(valid);
    expect(parsed.shakiness).toBe(5);
    expect(parsed.smoothing).toBe(10);
    expect(parsed.accuracy).toBe(15);
    expect(parsed.zoom).toBe(5);
  });

  it('rejects shakiness out of [1, 10]', () => {
    expect(() => StabilizeInput.parse({ ...valid, shakiness: 0 })).toThrow();
    expect(() => StabilizeInput.parse({ ...valid, shakiness: 11 })).toThrow();
  });

  it('rejects smoothing out of [0, 40]', () => {
    expect(() => StabilizeInput.parse({ ...valid, smoothing: -1 })).toThrow();
    expect(() => StabilizeInput.parse({ ...valid, smoothing: 41 })).toThrow();
  });

  it('rejects accuracy out of [1, 15]', () => {
    expect(() => StabilizeInput.parse({ ...valid, accuracy: 0 })).toThrow();
    expect(() => StabilizeInput.parse({ ...valid, accuracy: 16 })).toThrow();
  });

  it('rejects zoom out of [0, 20]', () => {
    expect(() => StabilizeInput.parse({ ...valid, zoom: -1 })).toThrow();
    expect(() => StabilizeInput.parse({ ...valid, zoom: 21 })).toThrow();
  });

  it('rejects non-integer shakiness / smoothing / accuracy', () => {
    expect(() => StabilizeInput.parse({ ...valid, shakiness: 5.5 })).toThrow();
    expect(() => StabilizeInput.parse({ ...valid, smoothing: 10.5 })).toThrow();
    expect(() => StabilizeInput.parse({ ...valid, accuracy: 9.5 })).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => StabilizeInput.parse({ input: '' })).toThrow();
  });
});
