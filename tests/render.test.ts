import { describe, expect, it } from 'vitest';
import { buildRenderArgs } from '../src/ffmpeg/args/render.js';
import { RenderInput } from '../src/tools/render.js';

describe('buildRenderArgs', () => {
  const base = {
    input: 'in.mp4',
    output: 'out.mp4',
    format: 'mp4' as const,
    crf: 23,
    preset: 'medium' as const,
  };

  it('builds libx264 + aac for mp4', () => {
    const args = buildRenderArgs(base);
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args).toContain('-preset');
    expect(args).toContain('medium');
    expect(args).toContain('-crf');
    expect(args).toContain('23');
    expect(args).toContain('-pix_fmt');
    expect(args).toContain('yuv420p');
  });

  it('builds libx264 + aac for mov (same codecs, different container)', () => {
    const args = buildRenderArgs({ ...base, format: 'mov', output: 'out.mov' });
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args.at(-1)).toBe('out.mov');
  });

  it('builds libvpx-vp9 + libopus for webm (no preset, with -b:v 0)', () => {
    const args = buildRenderArgs({ ...base, format: 'webm', output: 'out.webm' });
    expect(args).toContain('libvpx-vp9');
    expect(args).toContain('libopus');
    expect(args).not.toContain('-preset'); // vp9 uses a different model
    expect(args).not.toContain('libx264');
    // The constant-quality magic incantation for vp9
    expect(args).toContain('-b:v');
    expect(args).toContain('0');
  });

  it('respects custom crf', () => {
    const args = buildRenderArgs({ ...base, crf: 18 });
    const idx = args.indexOf('-crf');
    expect(args[idx + 1]).toBe('18');
  });

  it('respects custom preset', () => {
    const args = buildRenderArgs({ ...base, preset: 'veryfast' });
    const idx = args.indexOf('-preset');
    expect(args[idx + 1]).toBe('veryfast');
  });

  it('adds scale filter when maxWidth is set', () => {
    const args = buildRenderArgs({ ...base, maxWidth: 1280 });
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toBe("scale='min(1280,iw)':-2");
  });

  it('omits -vf when maxWidth is not set', () => {
    const args = buildRenderArgs(base);
    expect(args).not.toContain('-vf');
  });

  it('scale filter prevents upscaling via min(W,iw)', () => {
    const args = buildRenderArgs({ ...base, maxWidth: 9999 });
    const vfIdx = args.indexOf('-vf');
    expect(args[vfIdx + 1]).toContain('min(9999,iw)');
  });

  it('every arg is a discrete string (no shell interpolation)', () => {
    const args = buildRenderArgs({ ...base, maxWidth: 1280 });
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('RenderInput', () => {
  it('accepts minimal input', () => {
    expect(() => RenderInput.parse({ input: 'a.mp4' })).not.toThrow();
  });

  it('applies sensible defaults', () => {
    const parsed = RenderInput.parse({ input: 'a.mp4' });
    expect(parsed.format).toBe('mp4');
    expect(parsed.crf).toBe(23);
    expect(parsed.preset).toBe('medium');
    expect(parsed.maxWidth).toBeUndefined();
  });

  it('rejects unknown format', () => {
    expect(() => RenderInput.parse({ input: 'a.mp4', format: 'avi' })).toThrow();
  });

  it('rejects unknown preset', () => {
    expect(() => RenderInput.parse({ input: 'a.mp4', preset: 'turbo' })).toThrow();
  });

  it('rejects crf out of range', () => {
    expect(() => RenderInput.parse({ input: 'a.mp4', crf: -1 })).toThrow();
    expect(() => RenderInput.parse({ input: 'a.mp4', crf: 52 })).toThrow();
  });

  it('rejects non-integer crf', () => {
    expect(() => RenderInput.parse({ input: 'a.mp4', crf: 23.5 })).toThrow();
  });

  it('rejects zero or negative maxWidth', () => {
    expect(() => RenderInput.parse({ input: 'a.mp4', maxWidth: 0 })).toThrow();
    expect(() => RenderInput.parse({ input: 'a.mp4', maxWidth: -100 })).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => RenderInput.parse({ input: '' })).toThrow();
  });
});
