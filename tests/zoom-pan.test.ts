import { describe, expect, it } from 'vitest';
import { buildZoomPanArgs } from '../src/ffmpeg/args/zoom-pan.js';
import { ZoomPanInput } from '../src/tools/zoom-pan.js';

describe('buildZoomPanArgs', () => {
  const base = {
    input: 'in.mp4',
    output: 'out.mp4',
    fromZoom: 1,
    toZoom: 1.5,
    centerX: 0.5,
    centerY: 0.5,
    totalFrames: 150,
    width: 640,
    height: 480,
    fps: 30,
    hasAudio: true,
  };

  it('builds the zoompan filter with all required params', () => {
    const args = buildZoomPanArgs(base);
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter).toContain("z='1+(0.5)*on/150'");
    expect(filter).toContain("x='0.5*iw-iw/(2*zoom)'");
    expect(filter).toContain("y='0.5*ih-ih/(2*zoom)'");
    expect(filter).toContain('d=150');
    expect(filter).toContain('s=640x480');
    expect(filter).toContain('fps=30');
  });

  it('builds a zoom-out (fromZoom>toZoom) with a negative delta', () => {
    const args = buildZoomPanArgs({ ...base, fromZoom: 2, toZoom: 1 });
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter).toContain("z='2+(-1)*on/150'");
  });

  it('honors custom center point', () => {
    const args = buildZoomPanArgs({ ...base, centerX: 0.25, centerY: 0.75 });
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter).toContain("x='0.25*iw-iw/(2*zoom)'");
    expect(filter).toContain("y='0.75*ih-ih/(2*zoom)'");
  });

  it('matches output size and fps to input (avoids resizing)', () => {
    const args = buildZoomPanArgs({ ...base, width: 1920, height: 1080, fps: 60 });
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter).toContain('s=1920x1080');
    expect(filter).toContain('fps=60');
  });

  it('stream-copies audio when present', () => {
    const args = buildZoomPanArgs(base);
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
  });

  it('omits audio codec when no audio', () => {
    const args = buildZoomPanArgs({ ...base, hasAudio: false });
    expect(args).not.toContain('-c:a');
  });

  it('every arg is a discrete string', () => {
    const args = buildZoomPanArgs(base);
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('ZoomPanInput', () => {
  const valid = { input: 'a.mp4' };

  it('accepts minimal input with defaults (1 → 1.5, center)', () => {
    expect(() => ZoomPanInput.parse(valid)).not.toThrow();
    const parsed = ZoomPanInput.parse(valid);
    expect(parsed.fromZoom).toBe(1);
    expect(parsed.toZoom).toBe(1.5);
    expect(parsed.centerX).toBe(0.5);
    expect(parsed.centerY).toBe(0.5);
  });

  it('rejects identical fromZoom and toZoom (static crop, not zoom_pan)', () => {
    expect(() => ZoomPanInput.parse({ ...valid, fromZoom: 1, toZoom: 1 })).toThrow();
    expect(() => ZoomPanInput.parse({ ...valid, fromZoom: 2, toZoom: 2 })).toThrow();
  });

  it('accepts zoom-out (fromZoom > toZoom)', () => {
    expect(() => ZoomPanInput.parse({ ...valid, fromZoom: 2, toZoom: 1 })).not.toThrow();
  });

  it('rejects zero or negative zoom', () => {
    expect(() => ZoomPanInput.parse({ ...valid, fromZoom: 0 })).toThrow();
    expect(() => ZoomPanInput.parse({ ...valid, toZoom: -1 })).toThrow();
  });

  it('rejects center coordinates out of [0, 1]', () => {
    expect(() => ZoomPanInput.parse({ ...valid, centerX: -0.1 })).toThrow();
    expect(() => ZoomPanInput.parse({ ...valid, centerX: 1.1 })).toThrow();
    expect(() => ZoomPanInput.parse({ ...valid, centerY: -0.1 })).toThrow();
    expect(() => ZoomPanInput.parse({ ...valid, centerY: 1.1 })).toThrow();
  });

  it('accepts center at the corners', () => {
    expect(() => ZoomPanInput.parse({ ...valid, centerX: 0, centerY: 0 })).not.toThrow();
    expect(() => ZoomPanInput.parse({ ...valid, centerX: 1, centerY: 1 })).not.toThrow();
  });

  it('rejects empty input', () => {
    expect(() => ZoomPanInput.parse({ input: '' })).toThrow();
  });
});
