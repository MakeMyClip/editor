import { describe, expect, it } from 'vitest';
import { buildOverlayArgs, type OverlayPosition } from '../src/ffmpeg/args/overlay.js';
import { OverlayInput } from '../src/tools/overlay.js';

describe('buildOverlayArgs', () => {
  const base = {
    input: 'main.mp4',
    overlay: 'logo.png',
    output: 'out.mp4',
    position: 'top-right' as OverlayPosition,
    startSec: 0,
    hasBaseAudio: true,
  };

  it('wires both inputs (base first, overlay second)', () => {
    const args = buildOverlayArgs(base);
    expect(args.indexOf('main.mp4')).toBeLessThan(args.indexOf('logo.png'));
  });

  it('uses null pass-through when no scaleToWidth', () => {
    const args = buildOverlayArgs(base);
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[1:v]null[ov]');
    expect(fc).not.toContain('scale=');
  });

  it('scales overlay when scaleToWidth set (-2 for even-pixel height)', () => {
    const args = buildOverlayArgs({ ...base, scaleToWidth: 200 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[1:v]scale=200:-2[ov]');
  });

  it('omits enable when startSec=0 and no endSec (overlay shown the whole video)', () => {
    const args = buildOverlayArgs(base);
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).not.toContain('enable=');
  });

  it("uses enable='gte(t,N)' when only startSec > 0", () => {
    const args = buildOverlayArgs({ ...base, startSec: 5 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain("enable='gte(t,5)'");
  });

  it("uses enable='between(t,start,end)' when endSec set", () => {
    const args = buildOverlayArgs({ ...base, startSec: 2, endSec: 7 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain("enable='between(t,2,7)'");
  });

  it('maps base audio when present', () => {
    const args = buildOverlayArgs(base);
    expect(args).toContain('0:a');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
  });

  it('skips base audio mapping when not present', () => {
    const args = buildOverlayArgs({ ...base, hasBaseAudio: false });
    expect(args).not.toContain('0:a');
    expect(args).not.toContain('-c:a');
  });

  it.each<[OverlayPosition, string, string]>([
    ['top-left', '20', '20'],
    ['top-center', '(W-w)/2', '20'],
    ['top-right', 'W-w-20', '20'],
    ['center-left', '20', '(H-h)/2'],
    ['center', '(W-w)/2', '(H-h)/2'],
    ['center-right', 'W-w-20', '(H-h)/2'],
    ['bottom-left', '20', 'H-h-20'],
    ['bottom-center', '(W-w)/2', 'H-h-20'],
    ['bottom-right', 'W-w-20', 'H-h-20'],
  ])('maps position %s to x=%s, y=%s', (position, x, y) => {
    const args = buildOverlayArgs({ ...base, position });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain(`x=${x}:y=${y}`);
  });
});

describe('OverlayInput', () => {
  const valid = { input: 'main.mp4', overlay: 'logo.png' };

  it('accepts minimal input', () => {
    expect(() => OverlayInput.parse(valid)).not.toThrow();
  });

  it('defaults position to top-right', () => {
    const { position } = OverlayInput.parse(valid);
    expect(position).toBe('top-right');
  });

  it('defaults startSec to 0', () => {
    const { startSec } = OverlayInput.parse(valid);
    expect(startSec).toBe(0);
  });

  it('rejects unknown position', () => {
    expect(() => OverlayInput.parse({ ...valid, position: 'sparkles' })).toThrow();
  });

  it('rejects negative startSec', () => {
    expect(() => OverlayInput.parse({ ...valid, startSec: -1 })).toThrow();
  });

  it('rejects endSec <= startSec', () => {
    expect(() => OverlayInput.parse({ ...valid, startSec: 5, endSec: 5 })).toThrow();
    expect(() => OverlayInput.parse({ ...valid, startSec: 5, endSec: 3 })).toThrow();
  });

  it('accepts endSec > startSec', () => {
    expect(() => OverlayInput.parse({ ...valid, startSec: 2, endSec: 7 })).not.toThrow();
  });

  it('rejects zero or negative scaleToWidth', () => {
    expect(() => OverlayInput.parse({ ...valid, scaleToWidth: 0 })).toThrow();
    expect(() => OverlayInput.parse({ ...valid, scaleToWidth: -100 })).toThrow();
  });

  it('rejects empty paths', () => {
    expect(() => OverlayInput.parse({ input: '', overlay: 'logo.png' })).toThrow();
    expect(() => OverlayInput.parse({ input: 'main.mp4', overlay: '' })).toThrow();
  });
});
