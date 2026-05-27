import { describe, expect, it } from 'vitest';
import {
  buildCropArgs,
  buildFlipArgs,
  buildRotateArgs,
  buildScaleArgs,
} from '../src/ffmpeg/args/transform.js';
import { TransformInput } from '../src/tools/transform.js';

describe('buildCropArgs', () => {
  it('emits crop=W:H:X:Y in -vf', () => {
    const args = buildCropArgs({
      input: 'in.mp4',
      output: 'out.mp4',
      x: 10,
      y: 20,
      width: 320,
      height: 240,
    });
    const vfIdx = args.indexOf('-vf');
    expect(args[vfIdx + 1]).toBe('crop=320:240:10:20');
  });

  it('re-encodes video and stream-copies audio', () => {
    const args = buildCropArgs({ input: 'a', output: 'b', x: 0, y: 0, width: 10, height: 10 });
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
  });
});

describe('buildRotateArgs', () => {
  it.each<[90 | 180 | 270, string]>([
    [90, 'transpose=1'],
    [270, 'transpose=2'],
    [180, 'transpose=1,transpose=1'],
  ])('maps %s° to %s', (degrees, expected) => {
    const args = buildRotateArgs({ input: 'in', output: 'out', degrees });
    expect(args[args.indexOf('-vf') + 1]).toBe(expected);
  });
});

describe('buildFlipArgs', () => {
  it('uses hflip for horizontal', () => {
    const args = buildFlipArgs({ input: 'a', output: 'b', axis: 'horizontal' });
    expect(args[args.indexOf('-vf') + 1]).toBe('hflip');
  });

  it('uses vflip for vertical', () => {
    const args = buildFlipArgs({ input: 'a', output: 'b', axis: 'vertical' });
    expect(args[args.indexOf('-vf') + 1]).toBe('vflip');
  });
});

describe('buildScaleArgs', () => {
  it('uses -2 for auto-fit on omitted dimensions (H.264 even-pixel requirement)', () => {
    const args = buildScaleArgs({ input: 'a', output: 'b', width: 1280 });
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1280:-2');
  });

  it('honors explicit width + height', () => {
    const args = buildScaleArgs({ input: 'a', output: 'b', width: 640, height: 480 });
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=640:480');
  });

  it('uses -2 -2 when nothing is set (no-op-ish but harmless)', () => {
    const args = buildScaleArgs({ input: 'a', output: 'b' });
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-2:-2');
  });

  it('uses -2 for auto-fit on width when only height set', () => {
    const args = buildScaleArgs({ input: 'a', output: 'b', height: 720 });
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-2:720');
  });
});

describe('TransformInput', () => {
  it('accepts a valid crop', () => {
    expect(() =>
      TransformInput.parse({ op: 'crop', input: 'a.mp4', x: 0, y: 0, width: 100, height: 100 }),
    ).not.toThrow();
  });

  it('accepts a valid rotate (90 / 180 / 270 only)', () => {
    for (const degrees of [90, 180, 270] as const) {
      expect(() => TransformInput.parse({ op: 'rotate', input: 'a.mp4', degrees })).not.toThrow();
    }
  });

  it('rejects arbitrary rotations like 45', () => {
    expect(() => TransformInput.parse({ op: 'rotate', input: 'a.mp4', degrees: 45 })).toThrow();
  });

  it('rejects flip with bad axis', () => {
    expect(() => TransformInput.parse({ op: 'flip', input: 'a.mp4', axis: 'diagonal' })).toThrow();
  });

  it('rejects scale with neither width nor height', () => {
    expect(() => TransformInput.parse({ op: 'scale', input: 'a.mp4' })).toThrow();
  });

  it('accepts scale with just width', () => {
    expect(() => TransformInput.parse({ op: 'scale', input: 'a.mp4', width: 1280 })).not.toThrow();
  });

  it('accepts scale with just height', () => {
    expect(() => TransformInput.parse({ op: 'scale', input: 'a.mp4', height: 720 })).not.toThrow();
  });

  it('rejects unknown op', () => {
    expect(() => TransformInput.parse({ op: 'morph', input: 'a.mp4' })).toThrow();
  });

  it('rejects crop with negative coordinates', () => {
    expect(() =>
      TransformInput.parse({ op: 'crop', input: 'a.mp4', x: -1, y: 0, width: 10, height: 10 }),
    ).toThrow();
  });

  it('rejects crop with zero-size rectangle', () => {
    expect(() =>
      TransformInput.parse({ op: 'crop', input: 'a.mp4', x: 0, y: 0, width: 0, height: 10 }),
    ).toThrow();
  });
});
