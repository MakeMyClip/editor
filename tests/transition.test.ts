import { describe, expect, it } from 'vitest';
import { buildTransitionArgs } from '../src/ffmpeg/args/transition.js';
import { TransitionInput } from '../src/tools/transition.js';

describe('buildTransitionArgs', () => {
  const base = {
    inputA: 'a.mp4',
    inputB: 'b.mp4',
    output: 'out.mp4',
    kind: 'fade' as const,
    durationSec: 1,
    offsetSec: 4,
    hasAudio: true,
  };

  it('emits both inputs in order', () => {
    const args = buildTransitionArgs(base);
    const aIdx = args.indexOf('a.mp4');
    const bIdx = args.indexOf('b.mp4');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(bIdx);
  });

  it('wires xfade + acrossfade when hasAudio is true', () => {
    const args = buildTransitionArgs(base);
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[0:v][1:v]xfade=transition=fade:duration=1:offset=4[v]');
    expect(fc).toContain('[0:a][1:a]acrossfade=d=1[a]');
  });

  it('wires xfade only when hasAudio is false', () => {
    const args = buildTransitionArgs({ ...base, hasAudio: false });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('xfade=transition=fade');
    expect(fc).not.toContain('acrossfade');
  });

  it('maps both [v] and [a] when hasAudio', () => {
    const args = buildTransitionArgs(base);
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === '-map' ? [...acc, i] : acc), []);
    expect(mapIndices.length).toBe(2);
    expect(args[mapIndices[0]! + 1]).toBe('[v]');
    expect(args[mapIndices[1]! + 1]).toBe('[a]');
  });

  it('maps only [v] when no audio', () => {
    const args = buildTransitionArgs({ ...base, hasAudio: false });
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === '-map' ? [...acc, i] : acc), []);
    expect(mapIndices.length).toBe(1);
    expect(args[mapIndices[0]! + 1]).toBe('[v]');
  });

  it('includes audio codec (aac) only when hasAudio', () => {
    expect(buildTransitionArgs(base)).toContain('-c:a');
    expect(buildTransitionArgs({ ...base, hasAudio: false })).not.toContain('-c:a');
  });

  it.each([
    'fade',
    'fadeblack',
    'fadewhite',
    'dissolve',
    'wipeleft',
    'wiperight',
    'wipeup',
    'wipedown',
    'slideleft',
    'slideright',
    'circleopen',
    'circleclose',
  ] as const)('builds the right transition= argument for %s', (kind) => {
    const args = buildTransitionArgs({ ...base, kind });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain(`transition=${kind}`);
  });

  it('honors custom durationSec and offsetSec', () => {
    const args = buildTransitionArgs({ ...base, durationSec: 2.5, offsetSec: 7 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('duration=2.5');
    expect(fc).toContain('offset=7');
    expect(fc).toContain('acrossfade=d=2.5');
  });

  it('every arg is a discrete string (no shell interpolation)', () => {
    const args = buildTransitionArgs(base);
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('TransitionInput', () => {
  const valid = { inputA: 'a.mp4', inputB: 'b.mp4' };

  it('accepts minimal input', () => {
    expect(() => TransitionInput.parse(valid)).not.toThrow();
  });

  it('applies default kind=fade', () => {
    const { kind } = TransitionInput.parse(valid);
    expect(kind).toBe('fade');
  });

  it('applies default durationSec=1', () => {
    const { durationSec } = TransitionInput.parse(valid);
    expect(durationSec).toBe(1);
  });

  it('rejects unknown transition kind', () => {
    expect(() => TransitionInput.parse({ ...valid, kind: 'sparkles' })).toThrow();
  });

  it('rejects zero or negative durationSec', () => {
    expect(() => TransitionInput.parse({ ...valid, durationSec: 0 })).toThrow();
    expect(() => TransitionInput.parse({ ...valid, durationSec: -1 })).toThrow();
  });

  it('caps durationSec at 10', () => {
    expect(() => TransitionInput.parse({ ...valid, durationSec: 11 })).toThrow();
  });

  it('rejects empty input paths', () => {
    expect(() => TransitionInput.parse({ inputA: '', inputB: 'b.mp4' })).toThrow();
    expect(() => TransitionInput.parse({ inputA: 'a.mp4', inputB: '' })).toThrow();
  });

  it('rejects missing inputB', () => {
    expect(() => TransitionInput.parse({ inputA: 'a.mp4' })).toThrow();
  });
});
