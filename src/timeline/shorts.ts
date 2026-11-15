import { planCaptions } from './captions.js';
import { speedFactor, videoLayers } from './compile.js';
import {
  type Clip,
  type Composition,
  type Effect,
  type MediaClip,
  makeClipId,
} from './composition.js';
import { applyOps, type CompositionOp, mediaClip, videoTrack } from './ops.js';
import { type Aspect, canvasFor, planReframe } from './reframe.js';
import { MAIN_TIMELINE, type MediaId } from './schema.js';
import type { Transcript } from './transcript.js';

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
  lookup: ShortTranscriptLookup,
  mintId: () => string = makeClipId,
): Promise<ShortPlan> {
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
  for (const range of request.ranges) {
    const { clip, transcript } = await lookup(source, range.clipId, range.transcriptId);
    windows.push(wordWindow(transcript, range, clip));
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
  for (const piece of joined) {
    ops.push({
      op: 'addClip',
      trackId: SHORT_TRACK,
      clip: mediaClip({
        id: mintId(),
        mediaId: piece.mediaId,
        sourceInSec: piece.sourceInSec,
        sourceOutSec: piece.sourceOutSec,
        // Rounded to the microsecond: clean numbers, far inside the export's
        // abutting tolerance.
        startSec: Math.round(at * 1e6) / 1e6,
        effects: piece.effects,
      }),
    });
    at += piece.sourceOutSec - piece.sourceInSec;
  }

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
    const built = applyOps(target, ops);
    // Only the asked-for words: the lead reaches into the word before, which
    // whisper.cpp stretches over the pause, and it isn't part of the short.
    const plan = await planCaptions(
      built,
      { maxWords: request.maxWords },
      async (clipId, transcriptId) => {
        const found = await lookup(built, clipId, transcriptId);
        const asked = windows.filter((w) => w.mediaId === found.transcript.mediaId);
        const words = found.transcript.words.filter((_, i) =>
          asked.some((w) => i >= w.fromIndex && i <= w.toIndex),
        );
        return { ...found, transcript: { ...found.transcript, words } };
      },
      mintId,
    );
    ops.push(...plan.ops);
    captions = plan.captions;
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
    warnings: [],
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
      joined[joined.length - 1] = { ...prev, sourceOutSec: piece.sourceOutSec };
    } else {
      joined.push(piece);
    }
  }
  return joined;
}

function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}
