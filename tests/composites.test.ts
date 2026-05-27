import { describe, expect, it } from 'vitest';
import { AddCaptionsInput } from '../src/tools/add-captions.js';
import { AddTitleCardInput } from '../src/tools/add-title-card.js';
import { HighlightReelInput } from '../src/tools/highlight-reel.js';
import {
  computeKeepRegions,
  parseSilences,
  SilenceRemoveInput,
} from '../src/tools/silence-remove.js';

describe('AddTitleCardInput', () => {
  const valid = { input: 'video.mp4', text: 'Welcome' };

  it('accepts minimal input', () => {
    expect(() => AddTitleCardInput.parse(valid)).not.toThrow();
  });

  it('applies sensible defaults', () => {
    const parsed = AddTitleCardInput.parse(valid);
    expect(parsed.durationSec).toBe(2);
    expect(parsed.background).toBe('black');
    expect(parsed.fontSize).toBe(72);
    expect(parsed.fontColor).toBe('white');
  });

  it('accepts hex and 0x colors as background', () => {
    expect(() => AddTitleCardInput.parse({ ...valid, background: '#ff00aa' })).not.toThrow();
    expect(() => AddTitleCardInput.parse({ ...valid, background: '0xFF00AA' })).not.toThrow();
  });

  it('rejects bad background colors', () => {
    expect(() => AddTitleCardInput.parse({ ...valid, background: 'red' })).toThrow();
    expect(() => AddTitleCardInput.parse({ ...valid, background: '#fff' })).toThrow();
  });

  it('caps durationSec at 15', () => {
    expect(() => AddTitleCardInput.parse({ ...valid, durationSec: 20 })).toThrow();
  });
});

describe('AddCaptionsInput', () => {
  it('accepts an array of cues', () => {
    expect(() =>
      AddCaptionsInput.parse({
        input: 'a.mp4',
        cues: [
          { text: 'first', startSec: 0, endSec: 2 },
          { text: 'second', startSec: 2, endSec: 4 },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects empty cues array', () => {
    expect(() => AddCaptionsInput.parse({ input: 'a.mp4', cues: [] })).toThrow();
  });

  it('rejects cues with endSec <= startSec', () => {
    expect(() =>
      AddCaptionsInput.parse({
        input: 'a.mp4',
        cues: [{ text: 'bad', startSec: 5, endSec: 5 }],
      }),
    ).toThrow();
  });

  it('applies default position bottom-center per cue', () => {
    const parsed = AddCaptionsInput.parse({
      input: 'a.mp4',
      cues: [{ text: 'x', startSec: 0, endSec: 1 }],
    });
    expect(parsed.cues[0]?.position).toBe('bottom-center');
  });
});

describe('SilenceRemoveInput', () => {
  it('accepts minimal input with defaults', () => {
    const parsed = SilenceRemoveInput.parse({ input: 'a.mp4' });
    expect(parsed.noiseDb).toBe(-30);
    expect(parsed.minSilenceSec).toBe(0.5);
  });

  it('rejects positive noiseDb (decibels should be ≤ 0)', () => {
    expect(() => SilenceRemoveInput.parse({ input: 'a.mp4', noiseDb: 10 })).toThrow();
  });

  it('rejects zero or negative minSilenceSec', () => {
    expect(() => SilenceRemoveInput.parse({ input: 'a.mp4', minSilenceSec: 0 })).toThrow();
    expect(() => SilenceRemoveInput.parse({ input: 'a.mp4', minSilenceSec: -1 })).toThrow();
  });
});

describe('parseSilences', () => {
  it('extracts paired start/end markers', () => {
    const stderr = `
random preamble
[silencedetect @ 0x100] silence_start: 1.234
[silencedetect @ 0x100] silence_end: 2.345 | silence_duration: 1.111
[silencedetect @ 0x100] silence_start: 5.0
[silencedetect @ 0x100] silence_end: 7.5 | silence_duration: 2.5
some trailer
`;
    expect(parseSilences(stderr)).toEqual([
      { start: 1.234, end: 2.345 },
      { start: 5, end: 7.5 },
    ]);
  });

  it('drops unterminated start (no matching end)', () => {
    const stderr = `
[silencedetect @ 0x100] silence_start: 10
`;
    expect(parseSilences(stderr)).toEqual([]);
  });

  it('handles empty stderr', () => {
    expect(parseSilences('')).toEqual([]);
  });
});

describe('computeKeepRegions', () => {
  it('inverts a list of silences against the total duration', () => {
    const silences = [
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ];
    expect(computeKeepRegions(silences, 10)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 5 },
      { start: 6, end: 10 },
    ]);
  });

  it('returns single full-duration region when there are no silences', () => {
    expect(computeKeepRegions([], 10)).toEqual([{ start: 0, end: 10 }]);
  });

  it('returns empty when silence covers the whole duration', () => {
    expect(computeKeepRegions([{ start: 0, end: 10 }], 10)).toEqual([]);
  });

  it('handles silence at the start (no leading keep region)', () => {
    expect(computeKeepRegions([{ start: 0, end: 3 }], 10)).toEqual([{ start: 3, end: 10 }]);
  });

  it('handles silence at the end (no trailing keep region)', () => {
    expect(computeKeepRegions([{ start: 7, end: 10 }], 10)).toEqual([{ start: 0, end: 7 }]);
  });
});

describe('HighlightReelInput', () => {
  const valid = {
    input: 'long.mp4',
    segments: [
      { startSec: 10, endSec: 20 },
      { startSec: 40, endSec: 55 },
    ],
  };

  it('accepts minimal input', () => {
    expect(() => HighlightReelInput.parse(valid)).not.toThrow();
  });

  it('defaults transitionSec to 0.5', () => {
    const parsed = HighlightReelInput.parse(valid);
    expect(parsed.transitionSec).toBe(0.5);
    expect(parsed.transitionKind).toBeUndefined();
  });

  it('rejects fewer than 2 segments', () => {
    expect(() =>
      HighlightReelInput.parse({ input: 'a.mp4', segments: [{ startSec: 0, endSec: 1 }] }),
    ).toThrow();
  });

  it('rejects unknown transitionKind', () => {
    expect(() => HighlightReelInput.parse({ ...valid, transitionKind: 'sparkle' })).toThrow();
  });

  it('rejects transitionSec > 5', () => {
    expect(() => HighlightReelInput.parse({ ...valid, transitionSec: 6 })).toThrow();
  });
});
