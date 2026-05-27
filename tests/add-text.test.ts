import { describe, expect, it } from 'vitest';
import { buildAddTextArgs, type NamedPosition } from '../src/ffmpeg/args/add-text.js';
import { quoteFilterArg } from '../src/ffmpeg/escape.js';
import { AddTextInput } from '../src/tools/add-text.js';

describe('quoteFilterArg', () => {
  it('wraps simple strings in single quotes', () => {
    expect(quoteFilterArg('hello')).toBe("'hello'");
  });

  it('escapes internal single quotes', () => {
    expect(quoteFilterArg("don't")).toBe("'don\\'t'");
  });

  it('escapes backslashes', () => {
    expect(quoteFilterArg('a\\b')).toBe("'a\\\\b'");
  });

  it('escapes backslash before single quote (backslash escaped first)', () => {
    // Input "\\'" (literal backslash then single quote) should become "\\\\\\'"
    // — the backslash doubles to \\, and the quote becomes \'.
    expect(quoteFilterArg("\\'")).toBe("'\\\\\\''");
  });

  it('handles empty string', () => {
    expect(quoteFilterArg('')).toBe("''");
  });

  it('leaves colons, commas, brackets alone (single-quoting handles them)', () => {
    expect(quoteFilterArg('a:b,c[d];e')).toBe("'a:b,c[d];e'");
  });

  it('handles unicode without modification', () => {
    expect(quoteFilterArg('héllo 世界 🎬')).toBe("'héllo 世界 🎬'");
  });

  it('handles typical workspace paths', () => {
    expect(quoteFilterArg('/tmp/text-abc.txt')).toBe("'/tmp/text-abc.txt'");
  });

  it('handles macOS /var/folders paths', () => {
    const p = '/var/folders/dn/vk2rnbvx7k98/T/makemyclip-editor/add-text-123.txt';
    expect(quoteFilterArg(p)).toBe(`'${p}'`);
  });

  it('round-trips through a simulated parser', () => {
    const original = "tricky: 'value' with\\backslash and: more, stuff";
    const quoted = quoteFilterArg(original);
    // Simulate ffmpeg: strip outer quotes, unescape \' then \\ in that order
    const unquoted = quoted.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    expect(unquoted).toBe(original);
  });
});

describe('buildAddTextArgs', () => {
  const baseArgs = {
    input: 'in.mp4',
    output: 'out.mp4',
    textfile: '/tmp/text.txt',
    position: 'top-center' as NamedPosition,
    startSec: 1,
    endSec: 3,
  };

  it('emits the expected top-level args shape', () => {
    const args = buildAddTextArgs(baseArgs);
    expect(args[0]).toBe('-y');
    expect(args[1]).toBe('-i');
    expect(args[2]).toBe('in.mp4');
    expect(args[3]).toBe('-vf');
    expect(args[5]).toBe('-c:v');
    expect(args[6]).toBe('libx264');
    expect(args.at(-1)).toBe('out.mp4');
    // No shell=true, no string concat: every element is a discrete arg.
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });

  it('quotes the textfile path inside the filter', () => {
    const filter = buildAddTextArgs(baseArgs)[4];
    expect(filter).toContain("textfile='/tmp/text.txt'");
  });

  it('uses default fontsize 48 when omitted', () => {
    const filter = buildAddTextArgs(baseArgs)[4];
    expect(filter).toContain('fontsize=48');
  });

  it('respects custom fontsize', () => {
    const filter = buildAddTextArgs({ ...baseArgs, fontSize: 96 })[4];
    expect(filter).toContain('fontsize=96');
  });

  it('defaults to white color', () => {
    const filter = buildAddTextArgs(baseArgs)[4];
    expect(filter).toContain("fontcolor='white'");
  });

  it('respects custom color', () => {
    const filter = buildAddTextArgs({ ...baseArgs, color: '#ff0000' })[4];
    expect(filter).toContain("fontcolor='#ff0000'");
  });

  it('includes the translucent box by default', () => {
    const filter = buildAddTextArgs(baseArgs)[4];
    expect(filter).toContain('box=1');
    expect(filter).toContain("boxcolor='black@0.5'");
    expect(filter).toContain('boxborderw=8');
  });

  it('omits the box when box: false', () => {
    const filter = buildAddTextArgs({ ...baseArgs, box: false })[4];
    expect(filter).not.toContain('box=1');
  });

  it('maps startSec/endSec into the enable expression', () => {
    const filter = buildAddTextArgs({ ...baseArgs, startSec: 2.5, endSec: 7.25 })[4];
    expect(filter).toContain("enable='between(t,2.5,7.25)'");
  });

  it.each<[NamedPosition, string, string]>([
    ['top-left', '20', '20'],
    ['top-center', '(w-text_w)/2', '20'],
    ['top-right', 'w-text_w-20', '20'],
    ['center-left', '20', '(h-text_h)/2'],
    ['center', '(w-text_w)/2', '(h-text_h)/2'],
    ['center-right', 'w-text_w-20', '(h-text_h)/2'],
    ['bottom-left', '20', 'h-text_h-20'],
    ['bottom-center', '(w-text_w)/2', 'h-text_h-20'],
    ['bottom-right', 'w-text_w-20', 'h-text_h-20'],
  ])('maps position %s to x=%s, y=%s', (position, x, y) => {
    const filter = buildAddTextArgs({ ...baseArgs, position })[4];
    // Each coordinate ends up wrapped in single quotes by quoteFilterArg
    expect(filter).toContain(`x='${x}'`);
    expect(filter).toContain(`y='${y}'`);
  });
});

describe('AddTextInput', () => {
  const validInput = {
    input: 'video.mp4',
    text: 'Hello',
    position: 'bottom-center' as const,
    startSec: 0,
    endSec: 5,
  };

  it('accepts a minimal valid input', () => {
    expect(() => AddTextInput.parse(validInput)).not.toThrow();
  });

  it('applies default position bottom-center', () => {
    const { position } = AddTextInput.parse({ ...validInput, position: undefined });
    expect(position).toBe('bottom-center');
  });

  it('applies default fontSize 48', () => {
    const { fontSize } = AddTextInput.parse(validInput);
    expect(fontSize).toBe(48);
  });

  it('applies default color white', () => {
    const { color } = AddTextInput.parse(validInput);
    expect(color).toBe('white');
  });

  it('applies default box true', () => {
    const { box } = AddTextInput.parse(validInput);
    expect(box).toBe(true);
  });

  it('rejects unknown positions', () => {
    expect(() => AddTextInput.parse({ ...validInput, position: 'middle-middle' })).toThrow();
  });

  it('rejects fontSize below 8', () => {
    expect(() => AddTextInput.parse({ ...validInput, fontSize: 4 })).toThrow();
  });

  it('rejects fontSize above 300', () => {
    expect(() => AddTextInput.parse({ ...validInput, fontSize: 500 })).toThrow();
  });

  it('rejects empty text', () => {
    expect(() => AddTextInput.parse({ ...validInput, text: '' })).toThrow();
  });

  it('rejects text longer than 500 chars', () => {
    expect(() => AddTextInput.parse({ ...validInput, text: 'x'.repeat(501) })).toThrow();
  });

  it('rejects endSec <= startSec', () => {
    expect(() => AddTextInput.parse({ ...validInput, startSec: 5, endSec: 5 })).toThrow();
    expect(() => AddTextInput.parse({ ...validInput, startSec: 5, endSec: 3 })).toThrow();
  });

  it('accepts negative-rejected nonnegative startSec', () => {
    expect(() => AddTextInput.parse({ ...validInput, startSec: -1 })).toThrow();
  });
});
