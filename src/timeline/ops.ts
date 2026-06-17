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
  | { op: 'addTrack'; track: Track; index?: number }
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
  | { op: 'clearTransform'; clipId: string }
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
      const track = TrackSchema.parse(op.track);
      if (op.index === undefined) {
        draft.tracks.push(track);
      } else {
        // Clamp into range and insert at z-order position (used by undo to
        // restore a removed track at its original index).
        draft.tracks.splice(Math.max(0, Math.min(op.index, draft.tracks.length)), 0, track);
      }
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
    case 'clearTransform': {
      const { clip } = locateClip(draft, op.clipId);
      // Back to "no transform" (the inverse of a setTransform that created one).
      delete clip.transform;
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

  canonicalizeTracks(draft);
  return CompositionSchema.parse(draft);
}

/**
 * Put every track into a canonical array order — clips by (startSec, then id),
 * transitions by afterClipId — so two documents with identical CONTENT always
 * compare deep-equal regardless of the op history that built them. Array order is
 * otherwise semantically irrelevant: the export compiler keys transitions by
 * afterClipId and rejects overlapping (equal-start) clips, so nothing downstream
 * depends on it. Canonicalizing here is what makes the op-log reversible — undo
 * (apply an op's inverse) lands back on a byte-identical document instead of one
 * that merely has the same clips in a different array slot.
 */
function canonicalizeTracks(comp: Composition): void {
  const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const track of comp.tracks) {
    track.clips.sort((a, b) => a.startSec - b.startSec || byString(a.id, b.id));
    track.transitions.sort((a, b) => byString(a.afterClipId, b.afterClipId));
  }
}

/** Fold a sequence of ops left-to-right. */
export function applyOps(comp: Composition, ops: CompositionOp[]): Composition {
  return ops.reduce(applyOp, comp);
}

/**
 * Compute the inverse of `op` against the PRE-state `comp`: the op(s) that,
 * applied to the post-op document, restore `comp` exactly. Pure — it only reads
 * `comp` (capturing whatever the op overwrites or drops) and returns new ops; it
 * never mutates. This is what makes the doc op-log reversible: a writer records
 * `invertOp(current, op)` alongside the op, and undo replays the inverse.
 *
 * Assumes `op` is applicable to `comp` (the caller applies it immediately after).
 * It locates the entities it must capture and throws `CompositionOpError` if they
 * are missing — the same failure `applyOp` would raise. For ops `applyOp` would
 * reject on a *value* check (e.g. a degenerate trim), the inverse is harmless and
 * simply discarded when `applyOp` throws.
 */
export function invertOp(comp: Composition, op: CompositionOp): CompositionOp[] {
  switch (op.op) {
    case 'setCanvas':
      // Restore only the fields this op actually overwrote.
      return [
        {
          op: 'setCanvas',
          ...(op.width !== undefined ? { width: comp.width } : {}),
          ...(op.height !== undefined ? { height: comp.height } : {}),
          ...(op.fps !== undefined ? { fps: comp.fps } : {}),
          ...(op.background !== undefined ? { background: comp.background } : {}),
        },
      ];
    case 'addTrack':
      return [{ op: 'removeTrack', trackId: op.track.id }];
    case 'removeTrack': {
      const index = comp.tracks.findIndex((t) => t.id === op.trackId);
      const track = comp.tracks[index];
      if (!track) throw new CompositionOpError(`No track "${op.trackId}" to invert removal of.`);
      // Re-insert the whole track (clips + transitions) at its original z-index.
      return [{ op: 'addTrack', track: structuredClone(track), index }];
    }
    case 'addClip':
      return [{ op: 'removeClip', clipId: op.clip.id }];
    case 'removeClip': {
      const { track, clip } = locateClip(comp, op.clipId);
      const inverse: CompositionOp[] = [
        { op: 'addClip', trackId: track.id, clip: structuredClone(clip) },
      ];
      // removeClip also drops the transition that followed the clip — restore it.
      for (const t of track.transitions) {
        if (t.afterClipId === op.clipId) {
          inverse.push({ op: 'addTransition', trackId: track.id, transition: structuredClone(t) });
        }
      }
      return inverse;
    }
    case 'moveClip': {
      const { track, clip } = locateClip(comp, op.clipId);
      const inverse: CompositionOp[] = [
        { op: 'moveClip', clipId: op.clipId, startSec: clip.startSec, toTrackId: track.id },
      ];
      // A cross-track move drops any transition that followed the clip on the
      // source track; re-add it after the clip is back.
      if (op.toTrackId !== undefined && op.toTrackId !== track.id) {
        for (const t of track.transitions) {
          if (t.afterClipId === op.clipId) {
            inverse.push({
              op: 'addTransition',
              trackId: track.id,
              transition: structuredClone(t),
            });
          }
        }
      }
      return inverse;
    }
    case 'setTrim': {
      const { clip } = locateClip(comp, op.clipId);
      if (clip.kind !== 'media') return []; // applyOp will reject; nothing to invert.
      return [
        {
          op: 'setTrim',
          clipId: op.clipId,
          sourceInSec: clip.sourceInSec,
          sourceOutSec: clip.sourceOutSec,
        },
      ];
    }
    case 'setDuration': {
      const { clip } = locateClip(comp, op.clipId);
      if (clip.kind === 'media') return []; // applyOp will reject.
      return [{ op: 'setDuration', clipId: op.clipId, durationSec: clip.durationSec }];
    }
    case 'splitClip': {
      const { track, clip } = locateClip(comp, op.clipId);
      const inverse: CompositionOp[] = [];
      // On split, the transition after the original clip migrates to the new
      // second half. Re-home it to the original, then remove the second half
      // (which drops the migrated copy), then restore the original's extent.
      const moved = track.transitions.find((t) => t.afterClipId === op.clipId);
      if (moved) {
        inverse.push({
          op: 'addTransition',
          trackId: track.id,
          transition: structuredClone(moved),
        });
      }
      inverse.push({ op: 'removeClip', clipId: op.newClipId });
      if (clip.kind === 'media') {
        inverse.push({
          op: 'setTrim',
          clipId: op.clipId,
          sourceInSec: clip.sourceInSec,
          sourceOutSec: clip.sourceOutSec,
        });
      } else {
        inverse.push({ op: 'setDuration', clipId: op.clipId, durationSec: clip.durationSec });
      }
      return inverse;
    }
    case 'addEffect': {
      const { clip } = locateClip(comp, op.clipId);
      const at =
        op.index === undefined
          ? clip.effects.length
          : Math.max(0, Math.min(op.index, clip.effects.length));
      return [{ op: 'removeEffect', clipId: op.clipId, index: at }];
    }
    case 'removeEffect': {
      const { clip } = locateClip(comp, op.clipId);
      const effect = clip.effects[op.index];
      if (!effect) return []; // out of range — applyOp will reject.
      return [
        { op: 'addEffect', clipId: op.clipId, effect: structuredClone(effect), index: op.index },
      ];
    }
    case 'setTransform': {
      const { clip } = locateClip(comp, op.clipId);
      if (clip.transform === undefined) return [{ op: 'clearTransform', clipId: op.clipId }];
      return [
        { op: 'setTransform', clipId: op.clipId, transform: structuredClone(clip.transform) },
      ];
    }
    case 'clearTransform': {
      const { clip } = locateClip(comp, op.clipId);
      if (clip.transform === undefined) return []; // already clear — no-op.
      return [
        { op: 'setTransform', clipId: op.clipId, transform: structuredClone(clip.transform) },
      ];
    }
    case 'addTransition': {
      const track = requireTrack(comp, op.trackId);
      const prior = track.transitions.find((t) => t.afterClipId === op.transition.afterClipId);
      // addTransition replaces any same-anchor transition: restore the prior one
      // if there was one, otherwise just remove what we added.
      if (prior)
        return [{ op: 'addTransition', trackId: op.trackId, transition: structuredClone(prior) }];
      return [
        { op: 'removeTransition', trackId: op.trackId, afterClipId: op.transition.afterClipId },
      ];
    }
    case 'removeTransition': {
      const track = requireTrack(comp, op.trackId);
      const removed = track.transitions.find((t) => t.afterClipId === op.afterClipId);
      if (!removed) return []; // removed nothing — no-op.
      return [{ op: 'addTransition', trackId: op.trackId, transition: structuredClone(removed) }];
    }
    default: {
      const _exhaustive: never = op;
      throw new CompositionOpError(`Cannot invert unknown op: ${JSON.stringify(_exhaustive)}`);
    }
  }
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
