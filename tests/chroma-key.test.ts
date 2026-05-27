import { describe, expect, it } from 'vitest';
import { buildChromaKeyArgs } from '../src/ffmpeg/args/chroma-key.js';
import { ChromaKeyInput } from '../src/tools/chroma-key.js';

describe('buildChromaKeyArgs', () => {
  const base = {
    background: 'bg.mp4',
    foreground: 'fg.mp4',
    output: 'out.mp4',
    color: 'green',
    similarity: 0.3,
    blend: 0.1,
    backgroundIsImage: false,
    foregroundDurationSec: 5,
    takeForegroundAudio: false,
    hasAudio: true,
  };

  it('emits filter_complex with chromakey + overlay', () => {
    const args = buildChromaKeyArgs(base);
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain("chromakey=color='green':similarity=0.3:blend=0.1[fg]");
    expect(fc).toContain('[0:v][fg]overlay=shortest=1[v]');
  });

  it('places background before foreground (input order matters)', () => {
    const args = buildChromaKeyArgs(base);
    expect(args.indexOf('bg.mp4')).toBeLessThan(args.indexOf('fg.mp4'));
  });

  it('loops still-image background with -loop 1 -t <fgDuration>', () => {
    const args = buildChromaKeyArgs({ ...base, backgroundIsImage: true, foregroundDurationSec: 7 });
    const loopIdx = args.indexOf('-loop');
    expect(loopIdx).toBeGreaterThan(-1);
    expect(args[loopIdx + 1]).toBe('1');
    const tIdx = args.indexOf('-t');
    expect(tIdx).toBeGreaterThan(-1);
    expect(args[tIdx + 1]).toBe('7');
  });

  it('omits -loop/-t for video backgrounds', () => {
    const args = buildChromaKeyArgs(base);
    expect(args).not.toContain('-loop');
    expect(args).not.toContain('-t');
  });

  it('takes audio from background by default (0:a)', () => {
    const args = buildChromaKeyArgs(base);
    expect(args).toContain('0:a');
  });

  it('takes audio from foreground when takeForegroundAudio is true (1:a)', () => {
    const args = buildChromaKeyArgs({ ...base, takeForegroundAudio: true });
    expect(args).toContain('1:a');
    expect(args).not.toContain('0:a');
  });

  it('omits audio mapping entirely when hasAudio is false', () => {
    const args = buildChromaKeyArgs({ ...base, hasAudio: false });
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('0:a');
    expect(args).not.toContain('1:a');
  });

  it('quotes the color value (single-quoted via quoteFilterArg)', () => {
    const args = buildChromaKeyArgs({ ...base, color: '#00ff00' });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain("color='#00ff00'");
  });

  it('every arg is a discrete string (no shell interpolation)', () => {
    const args = buildChromaKeyArgs({ ...base, backgroundIsImage: true });
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('ChromaKeyInput', () => {
  const valid = { foreground: 'fg.mp4', background: 'bg.mp4' };

  it('accepts minimal input', () => {
    expect(() => ChromaKeyInput.parse(valid)).not.toThrow();
  });

  it('applies sensible defaults', () => {
    const parsed = ChromaKeyInput.parse(valid);
    expect(parsed.color).toBe('green');
    expect(parsed.similarity).toBe(0.3);
    expect(parsed.blend).toBe(0.1);
    expect(parsed.preferForegroundAudio).toBe(false);
  });

  it('accepts named, hex, and 0x colors', () => {
    expect(() => ChromaKeyInput.parse({ ...valid, color: 'blue' })).not.toThrow();
    expect(() => ChromaKeyInput.parse({ ...valid, color: '#00ff00' })).not.toThrow();
    expect(() => ChromaKeyInput.parse({ ...valid, color: '0xFF0000' })).not.toThrow();
  });

  it('rejects unknown color formats', () => {
    expect(() => ChromaKeyInput.parse({ ...valid, color: 'orange' })).toThrow();
    expect(() => ChromaKeyInput.parse({ ...valid, color: 'rgb(0,255,0)' })).toThrow();
    expect(() => ChromaKeyInput.parse({ ...valid, color: '#0f0' })).toThrow();
  });

  it('rejects similarity / blend out of [0, 1]', () => {
    expect(() => ChromaKeyInput.parse({ ...valid, similarity: -0.1 })).toThrow();
    expect(() => ChromaKeyInput.parse({ ...valid, similarity: 1.1 })).toThrow();
    expect(() => ChromaKeyInput.parse({ ...valid, blend: -0.1 })).toThrow();
    expect(() => ChromaKeyInput.parse({ ...valid, blend: 1.1 })).toThrow();
  });

  it('rejects empty paths', () => {
    expect(() => ChromaKeyInput.parse({ foreground: '', background: 'bg.mp4' })).toThrow();
    expect(() => ChromaKeyInput.parse({ foreground: 'fg.mp4', background: '' })).toThrow();
  });
});
