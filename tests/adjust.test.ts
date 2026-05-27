import { describe, expect, it } from 'vitest';
import { buildAdjustArgs } from '../src/ffmpeg/args/adjust.js';
import { AdjustInput } from '../src/tools/adjust.js';

describe('buildAdjustArgs', () => {
  const base = { input: 'in.mp4', output: 'out.mp4' };

  it('stream-copies video when no video adjustment set, encodes audio when volume set', () => {
    const args = buildAdjustArgs({ ...base, volume: 0.5 });
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-af') + 1]).toBe('volume=0.5');
    expect(args).not.toContain('-vf');
  });

  it('encodes video with eq filter when brightness set, copies audio when volume unchanged', () => {
    const args = buildAdjustArgs({ ...base, brightness: 0.2 });
    expect(args[args.indexOf('-vf') + 1]).toBe('eq=brightness=0.2');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
    expect(args).not.toContain('-af');
  });

  it('combines multiple video adjustments into one eq filter', () => {
    const args = buildAdjustArgs({ ...base, brightness: 0.1, contrast: 1.2, saturation: 1.5 });
    expect(args[args.indexOf('-vf') + 1]).toBe('eq=brightness=0.1:contrast=1.2:saturation=1.5');
  });

  it('omits eq when video values are at their no-op defaults', () => {
    const args = buildAdjustArgs({ ...base, brightness: 0, contrast: 1, saturation: 1 });
    expect(args).not.toContain('-vf');
  });

  it('handles all four adjustments simultaneously', () => {
    const args = buildAdjustArgs({
      ...base,
      brightness: -0.1,
      contrast: 1.5,
      saturation: 0,
      volume: 1.5,
    });
    expect(args[args.indexOf('-vf') + 1]).toBe('eq=brightness=-0.1:contrast=1.5:saturation=0');
    expect(args[args.indexOf('-af') + 1]).toBe('volume=1.5');
  });

  it('every arg is a discrete string', () => {
    const args = buildAdjustArgs({ ...base, brightness: 0.2, volume: 0.5 });
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('AdjustInput', () => {
  it('accepts an input with just one adjustment', () => {
    expect(() => AdjustInput.parse({ input: 'a.mp4', brightness: 0.1 })).not.toThrow();
    expect(() => AdjustInput.parse({ input: 'a.mp4', volume: 0.5 })).not.toThrow();
  });

  it('rejects an input with no adjustments at all', () => {
    expect(() => AdjustInput.parse({ input: 'a.mp4' })).toThrow();
  });

  it('rejects brightness out of [-1, 1]', () => {
    expect(() => AdjustInput.parse({ input: 'a.mp4', brightness: -1.1 })).toThrow();
    expect(() => AdjustInput.parse({ input: 'a.mp4', brightness: 1.1 })).toThrow();
  });

  it('rejects contrast out of [0, 4]', () => {
    expect(() => AdjustInput.parse({ input: 'a.mp4', contrast: -0.1 })).toThrow();
    expect(() => AdjustInput.parse({ input: 'a.mp4', contrast: 4.1 })).toThrow();
  });

  it('rejects saturation out of [0, 3]', () => {
    expect(() => AdjustInput.parse({ input: 'a.mp4', saturation: -0.1 })).toThrow();
    expect(() => AdjustInput.parse({ input: 'a.mp4', saturation: 3.1 })).toThrow();
  });

  it('rejects volume out of [0, 2]', () => {
    expect(() => AdjustInput.parse({ input: 'a.mp4', volume: -0.1 })).toThrow();
    expect(() => AdjustInput.parse({ input: 'a.mp4', volume: 2.1 })).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => AdjustInput.parse({ input: '', brightness: 0.1 })).toThrow();
  });
});
