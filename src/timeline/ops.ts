import {
  type Clip,
  type ColorClip,
  ColorClipSchema,
  type Composition,
  CompositionSchema,
  type Effect,
  type MediaClip,
  MediaClipSchema,
  makeClipId,
  makeTrackId,
  type TextClip,
  TextClipSchema,
  type TextStyle,
  type Track,
  TrackSchema,
  type Transform,
  TransformSchema,
  type Transition,
  TransitionSchema,
} from './composition.js';
import type { MediaId } from './schema.js';

/**
 * Declarative, reversible-by-history edit operations on a CompositionDoc. The
 * SAME op set is what a human's UI drag handlers and the agent's tools both
 * dispatch, so "human moved clip X" and "agent moved clip X" are one code path.
 *
 * Ops that create entities carry the new id (callers mint it via `makeClipId`/
 * `makeTrackId`) so `applyOp` stays a PURE function — no randomness, no clock —
 * and tests assert the resulting document deterministically.
 */
export type CompositionOp =
  | { op: 'setCanvas'; width?: number; height?: number; fps?: number; background?: string }
  | { op: 'addTrack'; track: Track }
  | { op: 'removeTrack'; trackId: string }
  | { op: 'addClip'; trackId: string; clip: Clip }
  | { op: 'removeClip'; clipId: string }
  | { op: 'moveClip'; clipId: string; startSec?: number; toTrackId?: string }
  | { op: 'setTrim'; clipId: string; sourceInSec?: number; sourceOutSec?: number }
  | { op: 'setDuration'; clipId: string; durationSec: number }
  | { op: 'splitClip'; clipId: string; atSec: number; newClipId: string }
  | { op: 'addEffect'; clipId: string; effect: Effect; index?: number }
  | { op: 'removeEffect'; clipId: string; index: number }
  | { op: 'setTransform'; clipId: string; transform: Partial<Transform> }
  | { op: 'addTransition'; trackId: string; transition: Transition }
  | { op: 'removeTransition'; trackId: string; afterClipId: string };

export type CompositionOpKind = CompositionOp['op'];

/** Thrown when an op references a missing entity or violates a clip invariant. */
export class CompositionOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionOpError';
  }
}

function requireTrack(comp: Composition, trackId: string): Track {
  const track = comp.tracks.find((t) => t.id === trackId);
  if (!track) throw new CompositionOpError(`No track "${trackId}" in composition.`);
  return track;
}

function locateClip(
  comp: Composition,
  clipId: string,
): { track: Track; index: number; clip: Clip } {
  for (const track of comp.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    const clip = track.clips[index];
    if (index !== -1 && clip) return { track, index, clip };
  }
  throw new CompositionOpError(`No clip "${clipId}" in composition.`);
}

/** Keep a track's clips ordered by timeline start so "the next clip" (for
 *  transitions and sequencing) is unambiguous. Stable for equal starts. */
function sortClips(track: Track): void {
  track.clips.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Apply one op to a composition, returning a NEW validated composition. Pure: it
 * deep-clones, mutates the clone, and re-parses through `CompositionSchema` so
 * the result is always a valid document (the always-valid invariant). Throws
 * `CompositionOpError` for missing entities or illegal clip mutations.
 */
export function applyOp(comp: Composition, op: CompositionOp): Composition {
  const draft: Composition = structuredClone(comp);

  switch (op.op) {
    case 'setCanvas': {
      if (op.width !== undefined) draft.width = op.width;
      if (op.height !== undefined) draft.height = op.height;
      if (op.fps !== undefined) draft.fps = op.fps;
      if (op.background !== undefined) draft.background = op.background;
      break;
    }
    case 'addTrack': {
      if (draft.tracks.some((t) => t.id === op.track.id)) {
        throw new CompositionOpError(`Track "${op.track.id}" already exists.`);
      }
      draft.tracks.push(TrackSchema.parse(op.track));
      break;
    }
    case 'removeTrack': {
      const before = draft.tracks.length;
      draft.tracks = draft.tracks.filter((t) => t.id !== op.trackId);
      if (draft.tracks.length === before) {
        throw new CompositionOpError(`No track "${op.trackId}" to remove.`);
      }
      break;
    }
    case 'addClip': {
      const track = requireTrack(draft, op.trackId);
      const clip = parseClip(op.clip);
      if (locate(draft, clip.id)) {
        throw new CompositionOpError(`Clip "${clip.id}" already exists.`);
      }
      track.clips.push(clip);
      sortClips(track);
      break;
    }
    case 'removeClip': {
      const { track } = locateClip(draft, op.clipId);
      track.clips = track.clips.filter((c) => c.id !== op.clipId);
      track.transitions = track.transitions.filter((t) => t.afterClipId !== op.clipId);
      break;
    }
    case 'moveClip': {
      const { track, clip } = locateClip(draft, op.clipId);
      if (op.startSec !== undefined) {
        if (op.startSec < 0) throw new CompositionOpError('startSec cannot be negative.');
        clip.startSec = op.startSec;
      }
      if (op.toTrackId !== undefined && op.toTrackId !== track.id) {
        const target = requireTrack(draft, op.toTrackId);
        track.clips = track.clips.filter((c) => c.id !== clip.id);
        track.transitions = track.transitions.filter((t) => t.afterClipId !== clip.id);
        target.clips.push(clip);
        sortClips(target);
      }
      sortClips(track);
      break;
    }
    case 'setTrim': {
      const { clip } = locateClip(draft, op.clipId);
      if (clip.kind !== 'media') {
        throw new CompositionOpError(`setTrim only applies to media clips, not "${clip.kind}".`);
      }
      const inSec = op.sourceInSec ?? clip.sourceInSec;
      const outSec = op.sourceOutSec ?? clip.sourceOutSec;
      if (inSec < 0) throw new CompositionOpError('sourceInSec cannot be negative.');
      if (outSec <= inSec) {
        throw new CompositionOpError(
          `sourceOutSec (${outSec}) must be greater than sourceInSec (${inSec}).`,
        );
      }
      clip.sourceInSec = inSec;
      clip.sourceOutSec = outSec;
      break;
    }
    case 'setDuration': {
      const { clip } = locateClip(draft, op.clipId);
      if (clip.kind === 'media') {
        throw new CompositionOpError(
          'setDuration applies to text/color clips; trim media clips instead.',
        );
      }
      if (op.durationSec <= 0) throw new CompositionOpError('durationSec must be positive.');
      clip.durationSec = op.durationSec;
      break;
    }
    case 'splitClip': {
      splitClipInDraft(draft, op.clipId, op.atSec, op.newClipId);
      break;
    }
    case 'addEffect': {
      const { clip } = locateClip(draft, op.clipId);
      const effect = op.effect;
      const at = op.index ?? clip.effects.length;
      clip.effects.splice(Math.max(0, Math.min(at, clip.effects.length)), 0, effect);
      break;
    }
    case 'removeEffect': {
      const { clip } = locateClip(draft, op.clipId);
      if (op.index < 0 || op.index >= clip.effects.length) {
        throw new CompositionOpError(
          `Effect index ${op.index} out of range (0..${clip.effects.length - 1}).`,
        );
      }
      clip.effects.splice(op.index, 1);
      break;
    }
    case 'setTransform': {
      const { clip } = locateClip(draft, op.clipId);
      const base = clip.transform ?? TransformSchema.parse({});
      clip.transform = { ...base, ...op.transform };
      break;
    }
    case 'addTransition': {
      const track = requireTrack(draft, op.trackId);
      if (!track.clips.some((c) => c.id === op.transition.afterClipId)) {
        throw new CompositionOpError(
          `Cannot add transition after "${op.transition.afterClipId}" — no such clip on track "${op.trackId}".`,
        );
      }
      track.transitions = track.transitions.filter(
        (t) => t.afterClipId !== op.transition.afterClipId,
      );
      track.transitions.push(TransitionSchema.parse(op.transition));
      break;
    }
    case 'removeTransition': {
      const track = requireTrack(draft, op.trackId);
      track.transitions = track.transitions.filter((t) => t.afterClipId !== op.afterClipId);
      break;
    }
    default: {
      const _exhaustive: never = op;
      throw new CompositionOpError(`Unknown op: ${JSON.stringify(_exhaustive)}`);
    }
  }

  return CompositionSchema.parse(draft);
}

/** Fold a sequence of ops left-to-right. */
export function applyOps(comp: Composition, ops: CompositionOp[]): Composition {
  return ops.reduce(applyOp, comp);
}

// ─── internals ───────────────────────────────────────────────────────────────

function locate(comp: Composition, clipId: string): boolean {
  return comp.tracks.some((t) => t.clips.some((c) => c.id === clipId));
}

function parseClip(clip: Clip): Clip {
  // Validate the incoming clip against its kind's schema (defaults filled).
  switch (clip.kind) {
    case 'media':
      return MediaClipSchema.parse(clip);
    case 'text':
      return TextClipSchema.parse(clip);
    case 'color':
      return ColorClipSchema.parse(clip);
  }
}

function splitClipInDraft(
  comp: Composition,
  clipId: string,
  atSec: number,
  newClipId: string,
): void {
  const { track, index, clip } = locateClip(comp, clipId);
  const offset = atSec - clip.startSec;
  const duration = clip.kind === 'media' ? clip.sourceOutSec - clip.sourceInSec : clip.durationSec;
  if (offset <= 0 || offset >= duration) {
    throw new CompositionOpError(
      `splitClip atSec=${atSec} is outside clip "${clipId}" (${clip.startSec}..${clip.startSec + duration}).`,
    );
  }
  if (locate(comp, newClipId)) {
    throw new CompositionOpError(`Clip "${newClipId}" already exists.`);
  }

  const second: Clip = structuredClone(clip);
  second.id = newClipId;
  second.startSec = atSec;

  if (clip.kind === 'media' && second.kind === 'media') {
    const splitPoint = clip.sourceInSec + offset;
    clip.sourceOutSec = splitPoint;
    second.sourceInSec = splitPoint;
  } else if (clip.kind !== 'media' && second.kind !== 'media') {
    clip.durationSec = offset;
    second.durationSec = duration - offset;
  }

  // A transition that fired after the original clip now belongs after the new
  // boundary (the second half), so the cut between the halves stays a hard cut.
  for (const t of track.transitions) {
    if (t.afterClipId === clipId) t.afterClipId = newClipId;
  }

  track.clips.splice(index + 1, 0, second);
  sortClips(track);
}

// ─── builders (ergonomic payload construction for ops/tests) ─────────────────

export function videoTrack(opts: { id?: string; muted?: boolean } = {}): Track {
  return TrackSchema.parse({ id: opts.id ?? makeTrackId(), kind: 'video', muted: opts.muted });
}

export function audioTrack(opts: { id?: string; muted?: boolean } = {}): Track {
  return TrackSchema.parse({ id: opts.id ?? makeTrackId(), kind: 'audio', muted: opts.muted });
}

export function mediaClip(params: {
  mediaId: MediaId;
  sourceOutSec: number;
  startSec: number;
  sourceInSec?: number;
  id?: string;
  transform?: Partial<Transform>;
  effects?: Effect[];
}): MediaClip {
  return MediaClipSchema.parse({
    kind: 'media',
    id: params.id ?? makeClipId(),
    mediaId: params.mediaId,
    sourceInSec: params.sourceInSec ?? 0,
    sourceOutSec: params.sourceOutSec,
    startSec: params.startSec,
    transform: params.transform,
    effects: params.effects,
  });
}

export function textClip(params: {
  text: string;
  durationSec: number;
  startSec: number;
  id?: string;
  style?: Partial<TextStyle>;
  transform?: Partial<Transform>;
  effects?: Effect[];
}): TextClip {
  return TextClipSchema.parse({
    kind: 'text',
    id: params.id ?? makeClipId(),
    text: params.text,
    durationSec: params.durationSec,
    startSec: params.startSec,
    style: params.style,
    transform: params.transform,
    effects: params.effects,
  });
}

export function colorClip(params: {
  durationSec: number;
  startSec: number;
  color?: string;
  id?: string;
  transform?: Partial<Transform>;
  effects?: Effect[];
}): ColorClip {
  return ColorClipSchema.parse({
    kind: 'color',
    id: params.id ?? makeClipId(),
    color: params.color,
    durationSec: params.durationSec,
    startSec: params.startSec,
    transform: params.transform,
    effects: params.effects,
  });
}
