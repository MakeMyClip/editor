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

/** Kept before a range's first word, so its attack isn't clipped. */
export const SHORT_LEAD_SEC = 0.1;
/** Kept after a range's last word, so its release and the breath after it aren't clipped. */
export const SHORT_TAIL_SEC = 0.25;
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
  /** Padded edges, source seconds. */
  start: number;
  end: number;
  /** First word's start and last word's end. */
  speechStart: number;
  speechEnd: number;
}

interface Piece extends ShortPiece {
  effects: Effect[];
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
      'That timeline already holds a short. Pass replace to rebuild it, or pick a new timeline id.',
    );
  }
  const picture = videoLayers(source).picture;
  if (!picture) {
    throw new ShortError(
      'The source timeline has no picture track to cut from: it is empty or has more than one.',
    );
  }

  const pieces: Piece[] = [];
  for (const range of request.ranges) {
    const { clip, transcript } = await lookup(source, range.clipId, range.transcriptId);
    const window = wordWindow(transcript, range, clip.id);
    const found = piecesUnder(picture.clips, clip.mediaId, window);
    if (found.length === 0) {
      throw new ShortError(
        `Words ${range.fromIndex}..${range.toIndex} were cut out of the source timeline, so there is nothing to play. Pick words that are still on it.`,
      );
    }
    pieces.push(...found);
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
    const plan = await planCaptions(
      built,
      { maxWords: request.maxWords },
      (clipId, transcriptId) => lookup(built, clipId, transcriptId),
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
 * The source window a range plays: its first word's start minus the lead to its
 * last word's end plus the tail. Each side stops at the neighboring word's edge,
 * so the padding never takes in part of a word outside the range, and at the
 * start of the file.
 */
function wordWindow(transcript: Transcript, range: ShortRange, clipId: string): WordWindow {
  const first = transcript.words[range.fromIndex];
  const last = transcript.words[range.toIndex];
  if (!first || !last || range.toIndex < range.fromIndex) {
    throw new ShortError(
      `Words ${range.fromIndex}..${range.toIndex} aren't in the transcript of clip "${clipId}" ` +
        `(it has ${transcript.words.length} words, numbered from 0).`,
    );
  }
  const before = transcript.words[range.fromIndex - 1];
  const after = transcript.words[range.toIndex + 1];
  const start = Math.min(
    first.startSec,
    Math.max(first.startSec - SHORT_LEAD_SEC, before?.endSec ?? 0, 0),
  );
  const end = Math.max(
    last.endSec,
    Math.min(last.endSec + SHORT_TAIL_SEC, after?.startSec ?? Number.POSITIVE_INFINITY),
  );
  return {
    start: roundMs(start),
    end: roundMs(end),
    speechStart: first.startSec,
    speechEnd: last.endSec,
  };
}

/**
 * The parts of a window that the source timeline's picture clips of one file
 * play, in timeline order. A moment the timeline plays twice is taken once, and
 * a part holding only padding (no word of the range) is left out, since it would
 * only add a jump cut.
 */
function piecesUnder(clips: readonly Clip[], mediaId: MediaId, window: WordWindow): Piece[] {
  const taken: [number, number][] = [];
  const pieces: Piece[] = [];
  for (const clip of [...clips].sort((a, b) => a.startSec - b.startSec)) {
    if (clip.kind !== 'media' || clip.mediaId !== mediaId) continue;
    const lo = Math.max(window.start, clip.sourceInSec);
    const hi = Math.min(window.end, clip.sourceOutSec);
    if (hi <= lo) continue;
    for (const [a, b] of subtract([lo, hi], taken)) {
      if (b - a < MIN_PIECE_SEC || b < window.speechStart || a > window.speechEnd) continue;
      const speed = speedFactor(clip.effects);
      if (speed !== 1) {
        throw new ShortError(
          `Clip "${clip.id}" on the source timeline plays at ${speed}x, and a short can't include a speed change yet. ` +
            'Remove its speed effect or pick words outside it.',
        );
      }
      pieces.push({
        mediaId,
        sourceInSec: a,
        sourceOutSec: b,
        // Fades belonged to the source clip's edges, not the short's.
        effects: clip.effects.filter((e) => e.type === 'adjust' || e.type === 'volume'),
      });
      taken.push([a, b]);
    }
  }
  return pieces;
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
