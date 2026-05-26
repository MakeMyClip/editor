import { describe, it, expect } from 'vitest';
import { buildTrimArgs } from '../src/ffmpeg/args/trim.js';
import { TrimInput } from '../src/tools/trim.js';
import { TimelineSchema, TimecodeSchema } from '../src/timeline/schema.js';

describe('buildTrimArgs', () => {
  it('puts -ss/-to before -i for fast seeking and uses stream copy', () => {
    const args = buildTrimArgs({
      input: 'in.mp4',
      start: '00:00:01',
      end: '00:00:05',
      output: 'out.mp4',
    });
    expect(args).toEqual([
      '-y',
      '-ss', '00:00:01',
      '-to', '00:00:05',
      '-i', 'in.mp4',
      '-c', 'copy',
      'out.mp4',
    ]);
  });

  it('preserves spaces in paths by keeping each arg separate (no shell concat)', () => {
    const args = buildTrimArgs({
      input: '/tmp/My Folder/in.mp4',
      start: '0',
      end: '10',
      output: '/tmp/My Folder/out.mp4',
    });
    expect(args).toContain('/tmp/My Folder/in.mp4');
    expect(args).toContain('/tmp/My Folder/out.mp4');
  });
});

describe('TrimInput schema', () => {
  it('accepts HH:MM:SS timecodes', () => {
    expect(() =>
      TrimInput.parse({ input: 'a.mp4', start: '00:00:01', end: '00:00:05' }),
    ).not.toThrow();
  });

  it('accepts plain seconds', () => {
    expect(() =>
      TrimInput.parse({ input: 'a.mp4', start: '1', end: '5.5' }),
    ).not.toThrow();
  });

  it('rejects garbage timecodes', () => {
    expect(() =>
      TrimInput.parse({ input: 'a.mp4', start: 'soon', end: 'later' }),
    ).toThrow();
  });

  it('rejects empty input path', () => {
    expect(() =>
      TrimInput.parse({ input: '', start: '0', end: '5' }),
    ).toThrow();
  });
});

describe('TimecodeSchema', () => {
  it('accepts HH:MM:SS.ms', () => {
    expect(TimecodeSchema.parse('01:23:45.678')).toBe('01:23:45.678');
  });

  it('rejects negative numbers', () => {
    expect(() => TimecodeSchema.parse('-5')).toThrow();
  });
});

describe('TimelineSchema', () => {
  it('parses a minimal valid timeline', () => {
    const t = TimelineSchema.parse({
      version: 1,
      clips: [{ source: 'a.mp4', start: '0', end: '10' }],
    });
    expect(t.clips).toHaveLength(1);
  });

  it('rejects empty clip list', () => {
    expect(() => TimelineSchema.parse({ version: 1, clips: [] })).toThrow();
  });

  it('rejects wrong version', () => {
    expect(() =>
      TimelineSchema.parse({ version: 2, clips: [{ source: 'a.mp4', start: '0', end: '1' }] }),
    ).toThrow();
  });
});
