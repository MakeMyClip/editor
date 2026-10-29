import { describe, expect, it } from 'vitest';
import { buildConcatArgs } from '../src/ffmpeg/args/concat.js';
import { ConcatPathError } from '../src/ffmpeg/escape.js';
import { buildConcatListContent, ConcatInput } from '../src/tools/concat.js';
import { parseConcatLine } from './ffmpeg-parse.js';

describe('buildConcatArgs', () => {
  it('emits stream-copy concat-demuxer args', () => {
    expect(buildConcatArgs({ listFile: '/tmp/list.txt', output: '/tmp/out.mp4' })).toEqual([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      '/tmp/list.txt',
      '-c',
      'copy',
      '/tmp/out.mp4',
    ]);
  });

  it('emits each argument as a discrete string (no shell interpolation)', () => {
    const args = buildConcatArgs({ listFile: 'a.txt', output: 'b.mp4' });
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('buildConcatListContent', () => {
  it('writes one quoted file line per input, trailing newline', () => {
    const content = buildConcatListContent(['/tmp/a.mp4', '/tmp/b.mp4']);
    expect(content).toBe("file '/tmp/a.mp4'\nfile '/tmp/b.mp4'\n");
  });

  it('handles three or more inputs', () => {
    const content = buildConcatListContent(['/a.mp4', '/b.mp4', '/c.mp4', '/d.mp4']);
    expect(content.split('\n').filter((l) => l.length > 0).length).toBe(4);
    expect(content.endsWith('\n')).toBe(true);
  });

  it('closes and reopens the quote around an apostrophe', () => {
    const content = buildConcatListContent(["/tmp/it's a file.mp4"]);
    expect(content).toBe("file '/tmp/it'\\''s a file.mp4'\n");
  });

  it('keeps backslashes literal inside the quotes', () => {
    const content = buildConcatListContent([String.raw`C:\videos\clip.mp4`]);
    expect(content).toBe("file 'C:\\videos\\clip.mp4'\n");
  });

  // Read each line back the way the concat demuxer does.
  it.each([
    "/tmp/it's a file.mp4",
    String.raw`C:\videos\clip.mp4`,
    String.raw`\\server\share\clip.mp4`,
    "/tmp/O'Brien, [take 2]; final.mp4",
    "/tmp/''.mp4",
    '/tmp/ leading and trailing .mp4 ',
    String.raw`/tmp/back\slash'quote.mp4`,
  ])('round-trips %j through the concat demuxer parse', (path) => {
    const [line] = buildConcatListContent([path]).split('\n');
    expect(parseConcatLine(line ?? '')).toBe(path);
  });

  it.each(['line\nbreak.mp4', 'carriage\rreturn.mp4', 'nul\0byte.mp4'])(
    'rejects %j, which cannot fit on one list line',
    (path) => {
      expect(() => buildConcatListContent([path])).toThrow(ConcatPathError);
      expect(() => buildConcatListContent([path])).toThrow(JSON.stringify(path));
    },
  );

  it('handles unicode paths', () => {
    const content = buildConcatListContent(['/tmp/世界.mp4']);
    expect(content).toBe("file '/tmp/世界.mp4'\n");
  });
});

describe('ConcatInput', () => {
  it('accepts two inputs', () => {
    expect(() => ConcatInput.parse({ inputs: ['a.mp4', 'b.mp4'] })).not.toThrow();
  });

  it('accepts many inputs', () => {
    const many = Array.from({ length: 50 }, (_, i) => `clip-${i}.mp4`);
    expect(() => ConcatInput.parse({ inputs: many })).not.toThrow();
  });

  it('rejects fewer than two inputs', () => {
    expect(() => ConcatInput.parse({ inputs: [] })).toThrow();
    expect(() => ConcatInput.parse({ inputs: ['only.mp4'] })).toThrow();
  });

  it('rejects empty string inputs', () => {
    expect(() => ConcatInput.parse({ inputs: ['a.mp4', ''] })).toThrow();
  });

  it('rejects missing inputs field', () => {
    expect(() => ConcatInput.parse({})).toThrow();
  });
});
