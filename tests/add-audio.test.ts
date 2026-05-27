import { describe, expect, it } from 'vitest';
import { buildAddAudioArgs } from '../src/ffmpeg/args/add-audio.js';
import { AddAudioInput } from '../src/tools/add-audio.js';

describe('buildAddAudioArgs — replace mode', () => {
  const base = {
    input: 'video.mp4',
    audio: 'music.mp3',
    output: 'out.mp4',
    mode: 'replace' as const,
    audioVolume: 1,
    startSec: 0,
  };

  it('maps video from input #0 and audio from input #1', () => {
    const args = buildAddAudioArgs(base);
    expect(args).toContain('-i');
    expect(args).toContain('video.mp4');
    expect(args).toContain('music.mp3');
    expect(args.indexOf('video.mp4')).toBeLessThan(args.indexOf('music.mp3'));
    expect(args).toContain('-map');
    expect(args).toContain('0:v');
    expect(args).toContain('1:a');
  });

  it('stream-copies video and encodes audio as aac', () => {
    const args = buildAddAudioArgs(base);
    const vcIdx = args.indexOf('-c:v');
    const acIdx = args.indexOf('-c:a');
    expect(args[vcIdx + 1]).toBe('copy');
    expect(args[acIdx + 1]).toBe('aac');
  });

  it('uses -shortest so we stop when the shorter stream ends', () => {
    expect(buildAddAudioArgs(base)).toContain('-shortest');
  });

  it('does not use filter_complex (no mixing needed)', () => {
    expect(buildAddAudioArgs(base)).not.toContain('-filter_complex');
  });
});

describe('buildAddAudioArgs — mix mode', () => {
  const base = {
    input: 'video.mp4',
    audio: 'music.mp3',
    output: 'out.mp4',
    mode: 'mix' as const,
    audioVolume: 0.5,
    startSec: 0,
  };

  it('builds filter_complex with volume + amix (no delay when startSec=0)', () => {
    const args = buildAddAudioArgs(base);
    const fcIdx = args.indexOf('-filter_complex');
    expect(fcIdx).toBeGreaterThan(-1);
    const fc = args[fcIdx + 1];
    expect(fc).toContain('[1:a]volume=0.5[ov]');
    expect(fc).toContain('amix=inputs=2:duration=first:dropout_transition=0[a]');
    expect(fc).not.toContain('adelay');
  });

  it('adds adelay when startSec > 0 (multiplied by 1000, repeated for stereo)', () => {
    const args = buildAddAudioArgs({ ...base, startSec: 2.5 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[ov]adelay=2500|2500[ovd]');
    expect(fc).toContain('[0:a][ovd]amix');
  });

  it('respects custom audioVolume', () => {
    const args = buildAddAudioArgs({ ...base, audioVolume: 0.2 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('volume=0.2');
  });

  it('maps video from input #0 and mixed audio from [a]', () => {
    const args = buildAddAudioArgs(base);
    expect(args).toContain('0:v');
    expect(args).toContain('[a]');
  });

  it('stream-copies video, encodes audio (mixing requires re-encode)', () => {
    const args = buildAddAudioArgs(base);
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
  });

  it('does NOT use -shortest in mix mode (duration=first in amix governs)', () => {
    expect(buildAddAudioArgs(base)).not.toContain('-shortest');
  });

  it('every arg is a discrete string (no shell interpolation)', () => {
    const args = buildAddAudioArgs({ ...base, startSec: 2.5 });
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('AddAudioInput', () => {
  const valid = { input: 'video.mp4', audio: 'music.mp3' };

  it('accepts minimal input', () => {
    expect(() => AddAudioInput.parse(valid)).not.toThrow();
  });

  it('applies sensible defaults', () => {
    const parsed = AddAudioInput.parse(valid);
    expect(parsed.mode).toBe('mix');
    expect(parsed.audioVolume).toBe(0.5);
    expect(parsed.startSec).toBe(0);
  });

  it('rejects unknown mode', () => {
    expect(() => AddAudioInput.parse({ ...valid, mode: 'duck' })).toThrow();
  });

  it('rejects negative volume', () => {
    expect(() => AddAudioInput.parse({ ...valid, audioVolume: -0.1 })).toThrow();
  });

  it('caps volume at 2', () => {
    expect(() => AddAudioInput.parse({ ...valid, audioVolume: 2.1 })).toThrow();
    expect(() => AddAudioInput.parse({ ...valid, audioVolume: 2 })).not.toThrow();
  });

  it('rejects negative startSec', () => {
    expect(() => AddAudioInput.parse({ ...valid, startSec: -1 })).toThrow();
  });

  it('rejects empty paths', () => {
    expect(() => AddAudioInput.parse({ input: '', audio: 'a.mp3' })).toThrow();
    expect(() => AddAudioInput.parse({ input: 'v.mp4', audio: '' })).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() => AddAudioInput.parse({ input: 'v.mp4' })).toThrow();
    expect(() => AddAudioInput.parse({ audio: 'a.mp3' })).toThrow();
  });
});
