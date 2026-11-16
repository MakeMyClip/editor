import {
  buildSpeechLevelsArgs,
  LEVEL_FRAME_SAMPLES,
  LEVEL_SAMPLE_RATE,
} from '../ffmpeg/args/speech-levels.js';
import { runFfmpeg } from '../ffmpeg/run.js';

/**
 * Pauses in speech, found in the audio itself. whisper.cpp's word edges run
 * late at sentence ends: it gives each pause to the word before it, and the
 * next word can start a third of a second into its own speech. A cut placed by
 * the transcript alone then keeps the start of the next sentence. Measured
 * levels show where the voice actually stops, so an edge is moved into the
 * pause the transcript points at.
 */

/** RMS level of each 10 ms of a source's audio, dBFS, from `fromSec` on. */
export interface SpeechLevels {
  fromSec: number;
  frameSec: number;
  db: number[];
}

/** A stretch of a source quiet enough to be a pause, in source seconds. */
export interface Pause {
  startSec: number;
  endSec: number;
}

/** Room tone kept between a cut and the speech beside it. */
export const PAUSE_KEEP_SEC = 0.1;
/** How far before the transcript's boundary the pause may lie: whisper runs
 *  up to about 0.75 s late there. */
const SEARCH_BEFORE_SEC = 0.9;
/** …and after it, for a boundary whisper put early. */
const SEARCH_AFTER_SEC = 0.05;
/** Measured around a boundary, for a noise floor and speech level of its own. */
const MEASURE_BEFORE_SEC = 1.5;
const MEASURE_AFTER_SEC = 1;
/** Quiet means this far over the window's floor (its 5th percentile)… */
const ABOVE_FLOOR_DB = 10;
/** …and this far under its speech (its 95th percentile). */
const BELOW_SPEECH_DB = 20;
/** The shortest quiet stretch counted as a pause. */
const MIN_PAUSE_SEC = 0.08;
/** Sound shorter than this inside a pause (a click, a lip noise) doesn't end it. */
const MAX_BLIP_SEC = 0.04;
/** Two pauses at least this long in reach make the boundary ambiguous. */
const COMPETING_PAUSE_SEC = 0.12;
const SILENT_DB = -120;
/** At or below this, a frame is digital silence, not a room. */
const DIGITAL_SILENCE_DB = -100;

/** Read the per-frame levels `buildSpeechLevelsArgs` prints. */
export function parseSpeechLevels(stderr: string, fromSec: number): SpeechLevels {
  const db: number[] = [];
  for (const match of stderr.matchAll(/lavfi\.astats\.Overall\.RMS_level=(\S+)/g)) {
    const value = Number(match[1]);
    db.push(Number.isFinite(value) ? Math.max(value, SILENT_DB) : SILENT_DB);
  }
  return { fromSec, frameSec: LEVEL_FRAME_SAMPLES / LEVEL_SAMPLE_RATE, db };
}

/** Measure a source's levels around a boundary (runs FFmpeg). */
export async function measureSpeechLevels(
  path: string,
  boundarySec: number,
): Promise<SpeechLevels> {
  const fromSec = Math.max(0, boundarySec - MEASURE_BEFORE_SEC);
  const durationSec = boundarySec + MEASURE_AFTER_SEC - fromSec;
  const { stderr } = await runFfmpeg(buildSpeechLevelsArgs({ input: path, fromSec, durationSec }));
  return parseSpeechLevels(stderr, fromSec);
}

/** Every pause in the levels, by a threshold set from the levels themselves. */
export function findPauses(levels: SpeechLevels): Pause[] {
  // Digital silence (padding where the audio starts late, or a muted stretch)
  // is quiet, but it isn't the room's floor: leave it out of the estimate, or
  // the room tone between sentences would count as sound.
  const sorted = levels.db.filter((level) => level > DIGITAL_SILENCE_DB).sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.floor(q * (sorted.length - 1))] ?? SILENT_DB;
  const threshold = Math.min(at(0.05) + ABOVE_FLOOR_DB, at(0.95) - BELOW_SPEECH_DB);
  const quiet = levels.db.map((level) => level <= DIGITAL_SILENCE_DB || level <= threshold);
  const maxBlip = Math.round(MAX_BLIP_SEC / levels.frameSec);
  // A short burst of sound between two quiet stretches is part of the pause.
  for (let i = 0; i < quiet.length; ) {
    if (quiet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < quiet.length && !quiet[j]) j++;
    if (i > 0 && j < quiet.length && j - i <= maxBlip) quiet.fill(true, i, j);
    i = j;
  }
  const pauses: Pause[] = [];
  for (let i = 0; i < quiet.length; ) {
    if (!quiet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < quiet.length && quiet[j]) j++;
    if ((j - i) * levels.frameSec >= MIN_PAUSE_SEC - 1e-9) {
      pauses.push({
        startSec: levels.fromSec + i * levels.frameSec,
        endSec: levels.fromSec + j * levels.frameSec,
      });
    }
    i = j;
  }
  return pauses;
}

/**
 * The pause at a transcript boundary: the longest pause reaching into
 * [boundary − 0.9 s, boundary + 0.05 s] that is still going after the word
 * the boundary ends has started (not the pause before that word). `none` when there is none (speech runs on, or music under
 * it); `ambiguous` when two pauses of 0.12 s or more are in reach, since the
 * transcript can't say which one it means.
 */
export function pauseAt(
  levels: SpeechLevels,
  boundarySec: number,
  wordBeforeStartSec: number,
): Pause | 'none' | 'ambiguous' {
  // A pause that ends by the time that word starts is the one before it.
  const from = Math.max(boundarySec - SEARCH_BEFORE_SEC, wordBeforeStartSec + SEARCH_AFTER_SEC);
  const to = boundarySec + SEARCH_AFTER_SEC;
  const inReach = findPauses(levels).filter((p) => p.endSec > from && p.startSec < to);
  if (inReach.length === 0) return 'none';
  if (inReach.filter((p) => p.endSec - p.startSec >= COMPETING_PAUSE_SEC - 1e-9).length > 1) {
    return 'ambiguous';
  }
  return inReach.reduce((a, b) => (b.endSec - b.startSec > a.endSec - a.startSec ? b : a));
}

/** Where a short ends in a pause: a little room tone after the voice stops. */
export function endInPause(pause: Pause): number {
  return pause.startSec + Math.min(PAUSE_KEEP_SEC, (pause.endSec - pause.startSec) / 2);
}

/** Where a short starts in a pause: a little room tone before the voice. */
export function startInPause(pause: Pause): number {
  return pause.endSec - Math.min(PAUSE_KEEP_SEC, (pause.endSec - pause.startSec) / 2);
}
