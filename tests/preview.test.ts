import { describe, expect, it } from 'vitest';
import { buildPreviewFrameArgs } from '../src/ffmpeg/args/preview.js';
import { PreviewInput } from '../src/tools/preview.js';

describe('buildPreviewFrameArgs', () => {
  it('emits fast-seek arg shape (-ss before -i)', () => {
    expect(buildPreviewFrameArgs({ input: 'in.mp4', output: 'out.jpg', atSec: 1.5 })).toEqual([
      '-y',
      '-ss',
      '1.5',
      '-i',
      'in.mp4',
      '-vframes',
      '1',
      '-q:v',
      '2',
      '-an',
      'out.jpg',
    ]);
  });

  it('seeks at 0 produces a clean zero string', () => {
    const args = buildPreviewFrameArgs({ input: 'a', output: 'b.jpg', atSec: 0 });
    expect(args[2]).toBe('0');
  });

  it('handles fractional seconds', () => {
    const args = buildPreviewFrameArgs({ input: 'a', output: 'b.jpg', atSec: 12.345 });
    expect(args[2]).toBe('12.345');
  });

  it('places -ss before -i (fast input-seek, not slow output-seek)', () => {
    const args = buildPreviewFrameArgs({ input: 'a', output: 'b.jpg', atSec: 5 });
    const ssIndex = args.indexOf('-ss');
    const iIndex = args.indexOf('-i');
    expect(ssIndex).toBeLessThan(iIndex);
  });

  it('emits every argument as a discrete string (no shell interpolation)', () => {
    const args = buildPreviewFrameArgs({ input: 'a', output: 'b.jpg', atSec: 1 });
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });

  it('skips audio decoding via -an', () => {
    const args = buildPreviewFrameArgs({ input: 'a', output: 'b.jpg', atSec: 1 });
    expect(args).toContain('-an');
  });

  it('asks for exactly one frame', () => {
    const args = buildPreviewFrameArgs({ input: 'a', output: 'b.jpg', atSec: 1 });
    const vframesIdx = args.indexOf('-vframes');
    expect(args[vframesIdx + 1]).toBe('1');
  });
});

describe('PreviewInput', () => {
  it('accepts a valid input', () => {
    expect(() => PreviewInput.parse({ input: 'video.mp4', atSec: 1.5 })).not.toThrow();
  });

  it('accepts atSec: 0', () => {
    expect(() => PreviewInput.parse({ input: 'a.mp4', atSec: 0 })).not.toThrow();
  });

  it('rejects negative atSec', () => {
    expect(() => PreviewInput.parse({ input: 'a.mp4', atSec: -1 })).toThrow();
  });

  it('rejects empty input path', () => {
    expect(() => PreviewInput.parse({ input: '', atSec: 1 })).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() => PreviewInput.parse({ input: 'a.mp4' })).toThrow();
    expect(() => PreviewInput.parse({ atSec: 1 })).toThrow();
    expect(() => PreviewInput.parse({})).toThrow();
  });
});
