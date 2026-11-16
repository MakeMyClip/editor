import {
  captionWidthBudget,
  DEFAULT_CAPTION_TRACK,
  DEFAULT_CAPTION_WORDS,
  defaultCaptionStyle,
  endsSentence,
  fitCaptionStyle,
  groupCaptions,
  PAUSE_SEC,
} from './captions.js';
import { speedFactor, videoLayers } from './compile.js';
import {
  type Clip,
  type Composition,
  clipEndSec,
  type Effect,
  type MediaClip,
  makeClipId,
} from './composition.js';
import { applyOps, type CompositionOp, mediaClip, textClip, videoTrack } from './ops.js';
import { endInPause, pauseAt, type SpeechLevels, startInPause } from './pauses.js';
import { type Aspect, canvasFor, planReframe } from './reframe.js';
import { MAIN_TIMELINE, type MediaId } from './schema.js';
import { clipWords, type Transcript } from './transcript.js';

/**
 * Shorts: a vertical clip cut out of a longer timeline by transcript word ranges,
 * built on a timeline of its own. It is cut from the source timeline's clips, not
 * from the raw file, so silence and retake cuts already made there carry in. It
 * is a snapshot: later edits to the source don't flow into it. The agent or the
 * person picks the words; nothing here scores highlights.
 */

/**
 * Kept before a range's first word. whisper.cpp hands each pause to the word
 * before it, so the next word tends to start late: on test speech its first
 * words started up to 0.35 s after the voice did. 0.25 s left 3 of 29 sentence
 * starts short by at most 0.1 s. A range ends where its last word does, with no
 * padding: that word already runs on through the pause after it.
 */
export const SHORT_LEAD_SEC = 0.25;
/** Loudness a short is normalized to unless asked otherwise: the vertical platforms' -14 LUFS. */
export const DEFAULT_SHORT_LUFS = -14;

const SHORT_TRACK = 'v0';
/** A range whose snapped edges leave less than this keeps the transcript's. */
const MIN_SNAPPED_SEC = 0.2;
/** How long a word pulled inside a cut lasts. */
const PULLED_WORD_SEC = 0.25;
/** The least a word starts after the one before it. */
const WORD_ORDER_SEC = 0.01;
/** A piece shorter than this is dropped: too short to hear, just a flash. */
const MIN_PIECE_SEC = 0.05;
const SAME_SEC = 1e-6;

/** Words `fromIndex..toIndex` (inclusive) of the transcript behind a media clip
 *  on the source timeline. */
export interface ShortRange {
  clipId: string;
  fromIndex: number;
  toIndex: number;
  /** The `transcriptId` the indices were read from; refused if it changed. */
  transcriptId?: string;
}

export interface ShortRequest {
  /** Played in this order, so a later moment can open the short as its hook. */
  ranges: ShortRange[];
  aspect?: Aspect;
  /** Horizontal position of the picture in the frame: 0 left, 0.5 center, 1 right. */
  x?: number;
  y?: number;
  /** Burn in captions (default true). */
  captions?: boolean;
  maxWords?: number;
  /** Default -14; null leaves loudness off. */
  targetLufs?: number | null;
  /** Rebuild a timeline that already holds a short. */
  replace?: boolean;
}

/** A window of a source file the short plays, in source seconds. */
export interface ShortPiece {
  mediaId: MediaId;
  sourceInSec: number;
  sourceOutSec: number;
}

export interface ShortPlan {
  ops: CompositionOp[];
  pieces: ShortPiece[];
  durationSec: number;
  /** Captions written (0 with captions off). */
  captions: number;
  warnings: string[];
}

/** Thrown when a short can't be made from the request. */
export class ShortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortError';
  }
}

/** A media clip of `comp` and its source's stored transcript (never transcribed here). */
export type ShortTranscriptLookup = (
  comp: Composition,
  clipId: string,
  transcriptId?: string,
) => Promise<{ clip: MediaClip; transcript: Transcript }>;

/** The audio levels of a media clip's source around a time, in source seconds
 *  (runs FFmpeg); null when the source has no sound. */
export type SpeechLevelsLookup = (
  comp: Composition,
  clipId: string,
  aroundSec: number,
) => Promise<SpeechLevels | null>;

/** What `planShort` reads beyond the documents. */
export interface ShortSources {
  transcript: ShortTranscriptLookup;
  /** Moves each edge into the pause the audio shows there. Without it, edges
   *  follow the transcript. */
  levels?: SpeechLevelsLookup;
  mintId?: () => string;
}

/** Refuse a short on `main` or on the timeline it is cut from. */
export function checkShortTimelines(target: string, source: string = MAIN_TIMELINE): void {
  if (target === MAIN_TIMELINE) {
    throw new ShortError(
      'A short is built on a timeline of its own: pick a new timeline id such as "best-1", not main.',
    );
  }
  if (source === target) {
    throw new ShortError(
      `A short can't be cut from its own timeline "${target}". Cut it from main or another timeline.`,
    );
  }
}

interface WordWindow {
  mediaId: MediaId;
  transcript: Transcript;
  /** The range's words, by index into its transcript. */
  fromIndex: number;
  toIndex: number;
  words: { startSec: number; endSec: number }[];
  /** Padded edges, source seconds. */
  start: number;
  end: number;
  /** First word's start and last word's end. */
  speechStart: number;
  speechEnd: number;
}

interface Piece extends ShortPiece {
  effects: Effect[];
  /** The source clip's speed, refused only if the piece is played. */
  speed: number;
  sourceClipId: string;
  transcript: Transcript;
  /** The word ranges the piece plays, which are what it captions, with the
   *  source window each was cut to. */
  asked: { fromIndex: number; toIndex: number; start: number; end: number }[];
}

/**
 * Plan the edit that builds a short on `target` from `source`: for each range,
 * the source timeline's clips under its words (padded), laid end to end on a
 * fresh picture track, on a 9:16 canvas filled edge to edge, normalized to
 * -14 LUFS and captioned. One batch, so one undo takes the whole short away.
 */
export async function planShort(
  target: Composition,
  source: Composition,
  request: ShortRequest,
  sources: ShortSources,
): Promise<ShortPlan> {
  const mintId = sources.mintId ?? makeClipId;
  if (request.ranges.length === 0) throw new ShortError('Give at least one word range.');
  if (!request.replace && target.tracks.some((t) => t.clips.length > 0)) {
    throw new ShortError(
      'That timeline already holds a short. Pass replace (`--replace`) to rebuild it, or pick a new timeline id.',
    );
  }
  const picture = videoLayers(source).picture;
  if (!picture) {
    throw new ShortError(
      'The source timeline has no picture track to cut from: it is empty or has more than one.',
    );
  }

  const windows: WordWindow[] = [];
  const warnings: string[] = [];
  for (const [i, range] of request.ranges.entries()) {
    const { clip, transcript } = await sources.transcript(source, range.clipId, range.transcriptId);
    const window = wordWindow(transcript, range, clip);
    warnings.push(...sentenceEdgeWarnings(window, i + 1));
    windows.push(
      sources.levels
        ? await snapToPauses(window, source, clip.id, sources.levels, i + 1, warnings)
        : window,
    );
  }
  const pieces: Piece[] = [];
  windows.forEach((window, i) => {
    const range = request.ranges[i];
    const found = piecesUnder(picture.clips, withoutReplay(window, windows[i - 1]));
    if (found.length === 0) {
      throw new ShortError(
        `Words ${range?.fromIndex}..${range?.toIndex} were cut out of the source timeline, so there is nothing to play. Pick words that are still on it.`,
      );
    }
    pieces.push(...found);
  });
  const sped = pieces.find((p) => p.speed !== 1);
  if (sped) {
    throw new ShortError(
      `Clip "${sped.sourceClipId}" on the source timeline plays at ${sped.speed}x, and a short can't include a speed change yet. ` +
        'Remove its speed effect or pick words outside it.',
    );
  }
  const joined = joinContinuous(pieces);

  const ops: CompositionOp[] = target.tracks.map(
    (t): CompositionOp => ({ op: 'removeTrack', trackId: t.id }),
  );
  const canvas = canvasFor(source, request.aspect ?? '9:16');
  ops.push(
    {
      op: 'setCanvas',
      width: canvas.width,
      height: canvas.height,
      fps: source.fps,
      background: source.background,
      fit: 'cover',
    },
    { op: 'addTrack', track: videoTrack({ id: SHORT_TRACK }) },
  );
  let at = 0;
  const placed = joined.map((piece) => {
    const clip = mediaClip({
      id: mintId(),
      mediaId: piece.mediaId,
      sourceInSec: piece.sourceInSec,
      sourceOutSec: piece.sourceOutSec,
      // Rounded to the microsecond: clean numbers, far inside the export's
      // abutting tolerance.
      startSec: Math.round(at * 1e6) / 1e6,
      effects: piece.effects,
    });
    ops.push({ op: 'addClip', trackId: SHORT_TRACK, clip });
    at += piece.sourceOutSec - piece.sourceInSec;
    return { piece, clip };
  });

  if (request.x !== undefined || request.y !== undefined) {
    const framed = planReframe(applyOps(target, ops), {
      width: canvas.width,
      height: canvas.height,
      fit: 'cover',
      x: request.x,
      y: request.y,
    });
    ops.push(...framed.ops);
  }

  const targetLufs = request.targetLufs === undefined ? DEFAULT_SHORT_LUFS : request.targetLufs;
  if ((target.loudness?.targetLufs ?? null) !== targetLufs) {
    ops.push({ op: 'setLoudness', targetLufs });
  }

  let captions = 0;
  if (request.captions !== false) {
    // Each piece captions only its own range's words: the lead reaches into the
    // word before, which whisper.cpp stretches over the pause, and that word
    // isn't part of the short even when another range asks for it.
    const built = applyOps(target, ops);
    const style = defaultCaptionStyle(built);
    const maxWidth = captionWidthBudget(built, style);
    const cues = placed.flatMap(({ piece, clip }) => {
      const words = piece.asked.flatMap((r) =>
        wordsInside(piece.transcript.words.slice(r.fromIndex, r.toIndex + 1), r.start, r.end),
      );
      return groupCaptions(
        clipWords({ ...piece.transcript, words }, clip),
        clipEndSec(clip),
        request.maxWords ?? DEFAULT_CAPTION_WORDS,
        maxWidth,
      );
    });
    if (cues.length > 0) {
      ops.push({ op: 'addTrack', track: videoTrack({ id: DEFAULT_CAPTION_TRACK }) });
      for (const cue of cues) {
        ops.push({
          op: 'addClip',
          trackId: DEFAULT_CAPTION_TRACK,
          clip: textClip({
            id: mintId(),
            text: cue.text,
            startSec: cue.startSec,
            durationSec: roundMs(cue.endSec - cue.startSec),
            style: fitCaptionStyle(cue.text, style, built),
          }),
        });
      }
    }
    captions = cues.length;
  }

  return {
    ops,
    pieces: joined.map(({ mediaId, sourceInSec, sourceOutSec }) => ({
      mediaId,
      sourceInSec,
      sourceOutSec,
    })),
    durationSec: roundMs(at),
    captions,
    warnings,
  };
}

/**
 * The source window a range plays: its first word's start minus the lead, to
 * its last word's end. The lead stops halfway into the word before (whisper.cpp
 * words abut, so that word also holds the pause) and at the start of the file.
 */
function wordWindow(transcript: Transcript, range: ShortRange, clip: MediaClip): WordWindow {
  const first = transcript.words[range.fromIndex];
  const last = transcript.words[range.toIndex];
  if (!first || !last || range.toIndex < range.fromIndex) {
    throw new ShortError(
      `Words ${range.fromIndex}..${range.toIndex} aren't in the transcript of clip "${clip.id}" ` +
        `(it has ${transcript.words.length} words, numbered from 0).`,
    );
  }
  const before = transcript.words[range.fromIndex - 1];
  const start = Math.min(
    first.startSec,
    Math.max(
      first.startSec - SHORT_LEAD_SEC,
      before ? (before.startSec + before.endSec) / 2 : 0,
      0,
    ),
  );
  return {
    mediaId: clip.mediaId,
    transcript,
    fromIndex: range.fromIndex,
    toIndex: range.toIndex,
    words: transcript.words.slice(range.fromIndex, range.toIndex + 1),
    start: roundMs(start),
    end: last.endSec,
    speechStart: first.startSec,
    speechEnd: last.endSec,
  };
}

/**
 * Move a range's edges into the pauses its source's audio shows at its
 * transcript boundaries: a little room tone before the first word and after
 * the last, never the next sentence's first syllable. An edge with no clear
 * pause (speech runs on, music under it, or two pauses the transcript can't
 * tell apart) keeps the transcript rule, with a warning unless the range was
 * cut mid-sentence there anyway.
 */
async function snapToPauses(
  window: WordWindow,
  source: Composition,
  clipId: string,
  levelsFor: SpeechLevelsLookup,
  rangeNumber: number,
  warnings: string[],
): Promise<WordWindow> {
  const words = window.transcript.words;
  const before = words[window.fromIndex - 1];
  const first = words[window.fromIndex];
  const last = words[window.toIndex];
  const after = words[window.toIndex + 1];
  if (!first || !last) return window;

  let { start, end } = window;
  let startLevels: SpeechLevels | null;
  let endLevels: SpeechLevels | null;
  try {
    startLevels = await levelsFor(source, clipId, first.startSec);
    endLevels = startLevels && (await levelsFor(source, clipId, last.endSec));
  } catch {
    // FFmpeg couldn't read the audio; the short is still made, by the transcript.
    warnings.push(
      `Range ${rangeNumber}: its audio couldn't be measured, so its edges follow the transcript. Look at it or listen.`,
    );
    return window;
  }
  if (!startLevels) return window; // no sound to measure
  const startPause = pauseAt(startLevels, first.startSec, before?.startSec ?? 0);
  if (typeof startPause === 'object') start = startInPause(startPause);
  else if (before && !midSentence(before, first)) {
    warnings.push(
      `Range ${rangeNumber}: no clear pause before "${first.text}", so its start follows the transcript and may clip that word or keep the end of "${before.text}". Look at it or listen.`,
    );
  }
  const endPause = endLevels ? pauseAt(endLevels, last.endSec, last.startSec) : 'none';
  if (typeof endPause === 'object') end = endInPause(endPause);
  else if (after && !midSentence(last, after)) {
    warnings.push(
      `Range ${rangeNumber}: no clear pause after "${last.text}", so its end follows the transcript and may keep the start of "${after.text}". Look at it or listen.`,
    );
  }
  // A pause found on the wrong side of a short range would leave nothing.
  if (end - start < MIN_SNAPPED_SEC) return window;
  start = roundMs(start);
  end = roundMs(end);
  return { ...window, start, end, words: wordsInside(window.words, start, end) };
}

/**
 * A range's words kept inside the window it was cut to, in order. A word
 * whisper places past an edge (it runs late at a sentence end) is pulled just
 * inside, so the range still holds its speech and the word keeps its caption;
 * no word starts before the one ahead of it, or a caption shown a word at a
 * time would lose that one.
 */
function wordsInside<W extends { startSec: number; endSec: number }>(
  words: W[],
  start: number,
  end: number,
): W[] {
  const starts = words.map((w) => {
    if (w.startSec >= end) return Math.max(start, end - PULLED_WORD_SEC);
    if (w.endSec <= start) return start;
    return w.startSec;
  });
  // In order going forward, then back from the cut: a word pushed up against
  // the end makes room by moving the ones before it earlier.
  for (let i = 1; i < starts.length; i++) {
    starts[i] = Math.max(starts[i] ?? 0, (starts[i - 1] ?? 0) + WORD_ORDER_SEC);
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    const limit = i === starts.length - 1 ? end : (starts[i + 1] ?? end);
    starts[i] = Math.max(start, Math.min(starts[i] ?? 0, limit - WORD_ORDER_SEC));
  }
  return words.map((w, i) => {
    const startSec = starts[i] ?? w.startSec;
    const endSec =
      w.startSec >= end
        ? end
        : w.endSec <= start
          ? Math.min(end, start + PULLED_WORD_SEC)
          : Math.max(w.endSec, startSec + WORD_ORDER_SEC);
    return startSec === w.startSec && endSec === w.endSec ? w : { ...w, startSec, endSec };
  });
}

/** Whether two neighboring words belong to one sentence: no sentence end and
 *  no real pause between them. */
function midSentence(a: { text: string; endSec: number }, b: { startSec: number }): boolean {
  return !endsSentence(a.text) && b.startSec - a.endSec < PAUSE_SEC;
}

/**
 * Where a range starts or ends inside a sentence: right after a word that
 * doesn't end one (with no real pause between), or right before the next word
 * of the same sentence. Named by the words on either side; the short is still
 * made, since a cut mid-sentence can be meant.
 */
function sentenceEdgeWarnings(window: WordWindow, rangeNumber: number): string[] {
  const words = window.transcript.words;
  const warnings: string[] = [];
  const before = words[window.fromIndex - 1];
  const first = words[window.fromIndex];
  if (before && first && midSentence(before, first)) {
    warnings.push(
      `Range ${rangeNumber} starts mid-sentence, between "${before.text}" and "${first.text}" (word ${window.fromIndex}).`,
    );
  }
  const last = words[window.toIndex];
  const after = words[window.toIndex + 1];
  if (last && after && midSentence(last, after)) {
    warnings.push(
      `Range ${rangeNumber} ends mid-sentence, between "${last.text}" and "${after.text}" (word ${window.toIndex}).`,
    );
  }
  return warnings;
}

/**
 * A window that picks up later in the same file than the one before it starts
 * where that one's padding ended, so two ranges of neighboring words play
 * straight through instead of replaying the padding they share. A range that
 * repeats or goes back to earlier words is left as asked.
 */
function withoutReplay(window: WordWindow, before: WordWindow | undefined): WordWindow {
  if (
    !before ||
    before.mediaId !== window.mediaId ||
    window.speechStart < before.speechEnd ||
    window.start >= before.end
  ) {
    return window;
  }
  return { ...window, start: Math.min(before.end, window.speechStart) };
}

/**
 * The parts of a window that the source timeline's picture clips of its file
 * play, in timeline order. A moment the timeline plays twice is taken once.
 * Parts a split left continuous are joined first; then a part holding none of
 * the range's words (only padding) is left out, since it would only add a jump
 * cut, as is a sliver too short to see.
 */
function piecesUnder(clips: readonly Clip[], window: WordWindow): Piece[] {
  const taken: [number, number][] = [];
  const parts: Piece[] = [];
  for (const clip of [...clips].sort((a, b) => a.startSec - b.startSec)) {
    if (clip.kind !== 'media' || clip.mediaId !== window.mediaId) continue;
    const lo = Math.max(window.start, clip.sourceInSec);
    const hi = Math.min(window.end, clip.sourceOutSec);
    if (hi <= lo) continue;
    for (const [a, b] of subtract([lo, hi], taken)) {
      parts.push({
        mediaId: window.mediaId,
        sourceInSec: a,
        sourceOutSec: b,
        // Fades belonged to the source clip's edges, not the short's.
        effects: clip.effects.filter((e) => e.type === 'adjust' || e.type === 'volume'),
        speed: speedFactor(clip.effects),
        sourceClipId: clip.id,
        transcript: window.transcript,
        asked: [
          {
            fromIndex: window.fromIndex,
            toIndex: window.toIndex,
            start: window.start,
            end: window.end,
          },
        ],
      });
      taken.push([a, b]);
    }
  }
  return joinContinuous(parts).filter(
    (p) => p.sourceOutSec - p.sourceInSec >= MIN_PIECE_SEC && holdsSpeech(p, window),
  );
}

/** Whether a piece plays any of the range's words, not just touches one's edge
 *  or the gap between two that were cut. */
function holdsSpeech(piece: Piece, window: WordWindow): boolean {
  return window.words.some((w) =>
    w.endSec > w.startSec
      ? piece.sourceOutSec > w.startSec && piece.sourceInSec < w.endSec
      : piece.sourceInSec <= w.startSec && piece.sourceOutSec >= w.endSec,
  );
}

/** `[lo, hi]` minus the `taken` intervals, in order. */
function subtract([lo, hi]: [number, number], taken: [number, number][]): [number, number][] {
  let parts: [number, number][] = [[lo, hi]];
  for (const [a, b] of taken) {
    parts = parts.flatMap(([p, q]): [number, number][] => {
      if (b <= p || a >= q) return [[p, q]];
      const rest: [number, number][] = [];
      if (a > p) rest.push([p, a]);
      if (b < q) rest.push([b, q]);
      return rest;
    });
  }
  return parts;
}

/** Merge pieces that continue one another in the same file with the same
 *  effects (a split, not a cut, on the source), so the short has no cut there. */
function joinContinuous(pieces: Piece[]): Piece[] {
  const joined: Piece[] = [];
  for (const piece of pieces) {
    const prev = joined[joined.length - 1];
    if (
      prev &&
      prev.mediaId === piece.mediaId &&
      Math.abs(prev.sourceOutSec - piece.sourceInSec) < SAME_SEC &&
      prev.speed === piece.speed &&
      JSON.stringify(prev.effects) === JSON.stringify(piece.effects)
    ) {
      joined[joined.length - 1] = {
        ...prev,
        sourceOutSec: piece.sourceOutSec,
        // One range across a split comes back once, or its captions would repeat.
        asked: [
          ...prev.asked,
          ...piece.asked.filter(
            (r) => !prev.asked.some((q) => q.fromIndex === r.fromIndex && q.toIndex === r.toIndex),
          ),
        ],
      };
    } else {
      joined.push(piece);
    }
  }
  return joined;
}

function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}
