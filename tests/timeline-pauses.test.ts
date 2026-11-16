import { describe, expect, it } from 'vitest';
import { buildSpeechLevelsArgs } from '../src/ffmpeg/args/speech-levels.js';
import {
  endInPause,
  findPauses,
  parseSpeechLevels,
  pauseAt,
  type SpeechLevels,
  startInPause,
} from '../src/timeline/pauses.js';

/** Levels built from [seconds, dB] stretches, 10 ms a frame, from `fromSec`. */
function levelsOf(stretches: [number, number][], fromSec = 10): SpeechLevels {
  const db = stretches.flatMap(([sec, level]) =>
    Array.from({ length: Math.round(sec / 0.01) }, () => level),
  );
  return { fromSec, frameSec: 0.01, db };
}

const near = (value: number): number => Math.round(value * 1000) / 1000;

describe('buildSpeechLevelsArgs', () => {
  it('measures 10 ms of mono 16 kHz audio a frame over the window', () => {
    expect(buildSpeechLevelsArgs({ input: '/in.mp4', fromSec: 8.5, durationSec: 2.5 })).toEqual([
      '-hide_banner',
      '-nostats',
      '-ss',
      '8.5',
      '-t',
      '2.5',
      '-i',
      '/in.mp4',
      '-map',
      '0:a:0',
      '-af',
      'aresample=16000:async=1:first_pts=0,aformat=channel_layouts=mono,asetnsamples=n=160:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level',
      '-f',
      'null',
      '-',
    ]);
  });
});

describe('parseSpeechLevels', () => {
  it('reads one level a frame, digital silence as -120 dB', () => {
    const stderr = [
      '[Parsed_ametadata_4 @ 0x1] frame:0    pts:0       pts_time:0',
      '[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.RMS_level=-12.703566',
      '[Parsed_ametadata_4 @ 0x1] frame:1    pts:160     pts_time:0.01',
      '[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.RMS_level=-inf',
      '[Parsed_ametadata_4 @ 0x1] frame:2    pts:320     pts_time:0.02',
      '[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.RMS_level=-48.5',
    ].join('\n');
    expect(parseSpeechLevels(stderr, 3)).toEqual({
      fromSec: 3,
      frameSec: 0.01,
      db: [-12.703566, -120, -48.5],
    });
  });
});

describe('findPauses', () => {
  it('finds pauses by the window’s own floor and speech level', () => {
    // A noisy room: speech at -18 dB, room tone at -45 dB.
    const levels = levelsOf([
      [1, -18],
      [0.3, -45],
      [0.8, -18],
      [0.05, -45], // too short to be a pause
      [0.5, -18],
    ]);
    expect(findPauses(levels).map((p) => [near(p.startSec), near(p.endSec)])).toEqual([[11, 11.3]]);
  });

  it('keeps a pause whole across a click shorter than 40 ms', () => {
    const levels = levelsOf([
      [1, -20],
      [0.15, -60],
      [0.03, -25],
      [0.15, -60],
      [1, -20],
    ]);
    expect(findPauses(levels).map((p) => [near(p.startSec), near(p.endSec)])).toEqual([
      [11, 11.33],
    ]);
  });

  it('sets the floor by the room, not by digital silence before the audio starts', () => {
    const levels = levelsOf([
      [0.5, -120], // padding: the audio starts late
      [1, -20],
      [0.3, -62], // room tone between sentences
      [1, -20],
    ]);
    expect(findPauses(levels).map((p) => [near(p.startSec), near(p.endSec)])).toEqual([
      [10, 10.5],
      [11.5, 11.8],
    ]);
  });

  it('finds none in speech that never stops, or in a steady level', () => {
    expect(findPauses(levelsOf([[3, -20]]))).toEqual([]);
    const stepped = levelsOf([
      [1, -26],
      [1, -20],
      [1, -26],
    ]);
    expect(findPauses(stepped)).toEqual([]);
  });
});

describe('pauseAt', () => {
  // Speech, a 0.4 s pause from 11.2, speech again: whisper puts the boundary at
  // 11.75, inside the next sentence, and the last word started at 10.9.
  const levels = levelsOf([
    [1.2, -20],
    [0.4, -60],
    [1, -20],
  ]);

  it('finds the pause a late transcript boundary points at', () => {
    const pause = pauseAt(levels, 11.75, 10.9);
    expect(pause).toEqual({ startSec: expect.closeTo(11.2, 6), endSec: expect.closeTo(11.6, 6) });
    if (typeof pause !== 'object') throw new Error('expected a pause');
    expect(near(endInPause(pause))).toBe(11.3);
    expect(near(startInPause(pause))).toBe(11.5);
  });

  it('keeps half a short pause on each side', () => {
    expect(near(endInPause({ startSec: 5, endSec: 5.1 }))).toBe(5.05);
    expect(near(startInPause({ startSec: 5, endSec: 5.1 }))).toBe(5.05);
  });

  it('looks no earlier than the start of the word the boundary ends', () => {
    // The last word started at 11.65, after the pause: there's none for it.
    expect(pauseAt(levels, 11.75, 11.65)).toBe('none');
  });

  it('never takes the pause before the last word for the one after it', () => {
    // An accurate last word, 15–15.5, a long pause before it and a short one after.
    const around = levelsOf([
      [4.7, -20],
      [0.3, -60],
      [0.5, -20],
      [0.1, -60],
      [1, -20],
    ]);
    const pause = pauseAt(around, 15.5, 15);
    expect(pause).toEqual({ startSec: expect.closeTo(15.5, 6), endSec: expect.closeTo(15.6, 6) });
  });

  it('says none when speech runs on, and ambiguous when two pauses compete', () => {
    expect(pauseAt(levelsOf([[3, -20]]), 11.5, 11)).toBe('none');
    const two = levelsOf([
      [1, -20],
      [0.2, -60],
      [0.3, -20],
      [0.2, -60],
      [1, -20],
    ]);
    expect(pauseAt(two, 11.7, 10.5)).toBe('ambiguous');
  });
});
