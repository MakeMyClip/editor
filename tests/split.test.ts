import { describe, expect, it } from 'vitest';
import { buildSplitArgs } from '../src/ffmpeg/args/split.js';
import { SplitInput } from '../src/tools/split.js';

describe('buildSplitArgs', () => {
  it('builds two arg arrays: before with -to, after without', () => {
    const [before, after] = buildSplitArgs('in.mp4', 2.5, 'before.mp4', 'after.mp4');
    expect(before).toEqual([
      '-y',
      '-ss',
      '0',
      '-to',
      '2.5',
      '-i',
      'in.mp4',
      '-c',
      'copy',
      'before.mp4',
    ]);
    expect(after).toEqual(['-y', '-ss', '2.5', '-i', 'in.mp4', '-c', 'copy', 'after.mp4']);
  });

  it('places -ss/-to before -i on both halves (fast input-seek, required for -c copy)', () => {
    const [before, after] = buildSplitArgs('a', 1, 'b', 'c');
    expect(before.indexOf('-ss')).toBeLessThan(before.indexOf('-i'));
    expect(before.indexOf('-to')).toBeLessThan(before.indexOf('-i'));
    expect(after.indexOf('-ss')).toBeLessThan(after.indexOf('-i'));
  });

  it('omits -to on the after-half so ffmpeg reads through EOF', () => {
    const [, after] = buildSplitArgs('a', 1, 'b', 'c');
    expect(after).not.toContain('-to');
  });

  it('every arg is a discrete string (no shell interpolation)', () => {
    const [before, after] = buildSplitArgs('a', 1, 'b', 'c');
    expect(before.every((a) => typeof a === 'string')).toBe(true);
    expect(after.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('SplitInput', () => {
  it('accepts a valid input', () => {
    expect(() => SplitInput.parse({ input: 'a.mp4', atSec: 2 })).not.toThrow();
  });

  it('rejects atSec: 0 (split point must be strictly after the start)', () => {
    expect(() => SplitInput.parse({ input: 'a.mp4', atSec: 0 })).toThrow();
  });

  it('rejects negative atSec', () => {
    expect(() => SplitInput.parse({ input: 'a.mp4', atSec: -1 })).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => SplitInput.parse({ input: '', atSec: 1 })).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() => SplitInput.parse({ input: 'a.mp4' })).toThrow();
    expect(() => SplitInput.parse({ atSec: 1 })).toThrow();
  });
});
