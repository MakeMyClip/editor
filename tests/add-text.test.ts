import { describe, expect, it } from 'vitest';
import { buildAddTextArgs, type NamedPosition } from '../src/ffmpeg/args/add-text.js';
import { quoteFilterArg } from '../src/ffmpeg/escape.js';
import { AddTextInput } from '../src/tools/add-text.js';
import { parseFilter } from './ffmpeg-parse.js';

describe('quoteFilterArg', () => {
  it('leaves plain values readable', () => {
    expect(quoteFilterArg('hello')).toBe("'hello'");
    expect(quoteFilterArg('/tmp/text-abc.txt')).toBe("'/tmp/text-abc.txt'");
    expect(quoteFilterArg('between(t,1,2)')).toBe("'between(t,1,2)'");
    expect(quoteFilterArg('')).toBe("''");
  });

  it('escapes a Windows drive path for the option parser inside graph quotes', () => {
    expect(quoteFilterArg(String.raw`C:\Users\it's.txt`)).toBe(
      String.raw`'C\:\\Users\\it\'\''s.txt'`,
    );
  });

  // Each value is read back through FFmpeg's two parse steps (graph, then
  // option) and must come out unchanged, with nothing left over and no extra
  // options: an early stop or a stray key would mean the value leaked out.
  it.each([
    'hello',
    '',
    ' ',
    ' spaced name ',
    '\tleading tab',
    "don't",
    "'",
    "''",
    ':',
    '\\',
    String.raw`a\b`,
    String.raw`\'`,
    String.raw`trailing\\`,
    String.raw`C:\Users\Agent's work, [draft];\notes.txt`,
    String.raw`\\server\share\clip.txt`,
    'a,b;c[d]e',
    "x',drawtext=text=pwned",
    'x:fontcolor=red',
    '%{pts}',
    'line\nbreak',
    'héllo 世界 🎬',
  ])('round-trips %j through both FFmpeg parse steps', (value) => {
    const parsed = parseFilter(`drawtext=textfile=${quoteFilterArg(value)}:fontcolor='white'`);
    expect(parsed).toEqual({
      name: 'drawtext',
      options: { textfile: value, fontcolor: 'white' },
      rest: '',
    });
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
