import { describe, expect, it } from 'vitest';
import { buildAtempoChain, buildSpeedArgs } from '../src/ffmpeg/args/speed.js';
import { SpeedInput } from '../src/tools/speed.js';

describe('buildAtempoChain', () => {
  it('returns empty for factor=1 (no-op)', () => {
    expect(buildAtempoChain(1)).toBe('');
  });

  it('handles in-range factors directly', () => {
    expect(buildAtempoChain(1.5)).toBe('atempo=1.5');
    expect(buildAtempoChain(0.75)).toBe('atempo=0.75');
  });

  it('chains for factors above 2', () => {
    expect(buildAtempoChain(4)).toBe('atempo=2.0,atempo=2.0');
  });

  it('chains for factors below 0.5', () => {
    expect(buildAtempoChain(0.25)).toBe('atempo=0.5,atempo=0.5');
  });

  it('produces clean factor=3 chain (2.0 then remainder 1.5)', () => {
    expect(buildAtempoChain(3)).toBe('atempo=2.0,atempo=1.5');
  });

  it('handles very slow factor 0.125 (three halvings)', () => {
    expect(buildAtempoChain(0.125)).toBe('atempo=0.5,atempo=0.5,atempo=0.5');
  });
});

describe('buildSpeedArgs', () => {
  const base = {
    input: 'in.mp4',
    output: 'out.mp4',
    factor: 2,
    reverse: false,
    hasAudio: true,
  };

  it('builds setpts + atempo for factor change with audio', () => {
    const args = buildSpeedArgs(base);
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toBe('[0:v]setpts=PTS/2[v];[0:a]atempo=2.0[a]');
  });

  it('skips audio entirely when hasAudio=false', () => {
    const args = buildSpeedArgs({ ...base, hasAudio: false });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toBe('[0:v]setpts=PTS/2[v]');
    expect(args).not.toContain('[a]');
    expect(args).not.toContain('-c:a');
  });

  it('wires reverse with factor change', () => {
    const args = buildSpeedArgs({ ...base, reverse: true });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toBe('[0:v]reverse,setpts=PTS/2[v];[0:a]areverse,atempo=2.0[a]');
  });

  it('handles reverse with factor=1 (just reverse, no setpts)', () => {
    const args = buildSpeedArgs({ ...base, factor: 1, reverse: true });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toBe('[0:v]reverse[v];[0:a]areverse[a]');
  });

  it('chains atempo for factor=4', () => {
    const args = buildSpeedArgs({ ...base, factor: 4 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('atempo=2.0,atempo=2.0');
  });

  it('chains atempo for factor=0.25 (slow-mo)', () => {
    const args = buildSpeedArgs({ ...base, factor: 0.25 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('setpts=PTS/0.25');
    expect(fc).toContain('atempo=0.5,atempo=0.5');
  });

  it('maps [v] only when no audio', () => {
    const args = buildSpeedArgs({ ...base, hasAudio: false });
    const maps = args.reduce<number[]>((acc, v, i) => (v === '-map' ? [...acc, i] : acc), []);
    expect(maps.length).toBe(1);
  });

  it('maps both [v] and [a] with audio', () => {
    const args = buildSpeedArgs(base);
    const maps = args.reduce<number[]>((acc, v, i) => (v === '-map' ? [...acc, i] : acc), []);
    expect(maps.length).toBe(2);
  });
});

describe('SpeedInput', () => {
  it('accepts factor change', () => {
    expect(() => SpeedInput.parse({ input: 'a.mp4', factor: 2 })).not.toThrow();
  });

  it('accepts reverse with default factor', () => {
    expect(() => SpeedInput.parse({ input: 'a.mp4', reverse: true })).not.toThrow();
  });

  it('rejects no-op (factor=1, reverse=false)', () => {
    expect(() => SpeedInput.parse({ input: 'a.mp4' })).toThrow();
    expect(() => SpeedInput.parse({ input: 'a.mp4', factor: 1 })).toThrow();
  });

  it('rejects zero or negative factor', () => {
    expect(() => SpeedInput.parse({ input: 'a.mp4', factor: 0 })).toThrow();
    expect(() => SpeedInput.parse({ input: 'a.mp4', factor: -1 })).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => SpeedInput.parse({ input: '', factor: 2 })).toThrow();
  });
});
