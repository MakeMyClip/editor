import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { MediaIdSchema } from './schema.js';

/**
 * The CompositionDoc — the non-destructive, multi-track timeline document that
 * is the single source of truth for an edit. Every tool/op MUTATES this; the
 * export compiler READS it. Nothing renders straight from tool args.
 *
 * Model:
 *  - A composition has a canvas (width/height/fps/background) and ordered tracks.
 *  - Tracks stack by index: track 0 is the bottom layer, later tracks composite
 *    on top (z-order). `video` tracks contribute pixels + audio; `audio` tracks
 *    contribute audio only.
 *  - A clip sits on a track at `startSec` (timeline time). Its on-screen duration
 *    is derived for media (sourceOut − sourceIn) or explicit for text/color.
 *  - Visual clips carry an optional `transform` (scale/position/rotation/opacity)
 *    and an ordered, non-destructive `effects` stack.
 *  - Transitions live on a track, keyed to the clip they follow.
 *
 * Time is in seconds (floats) everywhere — the document is machine-edited, so
 * numeric seconds beat timecodes for arithmetic in the reducer and compiler.
 * Keyframed/animated parameters are intentionally OUT of v1 (a large surface the
 * design deferred); the schema leaves room to add them per-effect later.
 */

const COMPOSITION_VERSION = 1 as const;

/** 9 named anchor points shared with the legacy add_text/overlay tools. */
export const AnchorSchema = z.enum([
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);
export type Anchor = z.infer<typeof AnchorSchema>;

/** Crossfade / wipe family, shared with the legacy transition tool. */
export const TransitionKindSchema = z.enum([
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'circleopen',
  'circleclose',
]);
export type TransitionKind = z.infer<typeof TransitionKindSchema>;

/**
 * Geometric placement of a visual clip on the canvas. `x`/`y` are the clip
 * CENTER in normalized [0,1] canvas coordinates; `scale` multiplies the clip's
 * fitted size; `rotationDeg` rotates clockwise; `opacity` is [0,1].
 */
export const TransformSchema = z.object({
  scale: z.number().positive().default(1),
  x: z.number().default(0.5),
  y: z.number().default(0.5),
  rotationDeg: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
});
export type Transform = z.infer<typeof TransformSchema>;

/**
 * Non-destructive effects, applied in array order. Each variant maps 1:1 to an
 * existing FFmpeg arg-builder so the export compiler reuses tested primitives.
 */
export const EffectSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('adjust'),
    brightness: z.number().min(-1).max(1).default(0),
    contrast: z.number().min(0).max(4).default(1),
    saturation: z.number().min(0).max(3).default(1),
  }),
  z.object({ type: z.literal('speed'), factor: z.number().positive() }),
  z.object({ type: z.literal('volume'), gain: z.number().min(0).max(2) }),
  z.object({
    type: z.literal('chromaKey'),
    color: z.string().default('green'),
    similarity: z.number().min(0).max(1).default(0.3),
    blend: z.number().min(0).max(1).default(0.1),
  }),
  z.object({ type: z.literal('fadeIn'), durationSec: z.number().positive() }),
  z.object({ type: z.literal('fadeOut'), durationSec: z.number().positive() }),
]);
export type Effect = z.infer<typeof EffectSchema>;
export type EffectType = Effect['type'];

export const TextStyleSchema = z.object({
  fontSize: z.number().int().positive().default(48),
  color: z.string().default('white'),
  /** Box color behind the text, or null for none. */
  background: z.string().nullable().default(null),
  anchor: AnchorSchema.default('center'),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

// Fields shared by every clip kind. Spread into each discriminated member.
const clipCommon = {
  id: z.string().min(1),
  startSec: z.number().nonnegative(),
  transform: TransformSchema.optional(),
  effects: z.array(EffectSchema).default([]),
};

/** A trimmed window of a source media file. Duration = sourceOut − sourceIn. */
export const MediaClipSchema = z.object({
  kind: z.literal('media'),
  ...clipCommon,
  mediaId: MediaIdSchema,
  sourceInSec: z.number().nonnegative().default(0),
  sourceOutSec: z.number().positive(),
});
export type MediaClip = z.infer<typeof MediaClipSchema>;

/** A generated text layer (title, caption, lower-third). */
export const TextClipSchema = z.object({
  kind: z.literal('text'),
  ...clipCommon,
  text: z.string().min(1),
  durationSec: z.number().positive(),
  // `.default(fn)` (not `.default({})`): the default value must be the schema's
  // OUTPUT type, so materialize it by parsing an empty object through the field
  // defaults rather than handing Zod a bare `{}`.
  style: TextStyleSchema.default(() => TextStyleSchema.parse({})),
});
export type TextClip = z.infer<typeof TextClipSchema>;

/** A solid-color card (title-card background, filler, matte). */
export const ColorClipSchema = z.object({
  kind: z.literal('color'),
  ...clipCommon,
  color: z.string().default('black'),
  durationSec: z.number().positive(),
});
export type ColorClip = z.infer<typeof ColorClipSchema>;

export const ClipSchema = z.discriminatedUnion('kind', [
  MediaClipSchema,
  TextClipSchema,
  ColorClipSchema,
]);
export type Clip = z.infer<typeof ClipSchema>;
export type ClipKind = Clip['kind'];

/** A transition that plays between `afterClipId` and the clip that follows it
 *  on the same track. */
export const TransitionSchema = z.object({
  afterClipId: z.string().min(1),
  kind: TransitionKindSchema.default('fade'),
  durationSec: z.number().positive().max(10).default(1),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const TrackKindSchema = z.enum(['video', 'audio']);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const TrackSchema = z.object({
  id: z.string().min(1),
  kind: TrackKindSchema,
  clips: z.array(ClipSchema).default([]),
  transitions: z.array(TransitionSchema).default([]),
  muted: z.boolean().default(false),
});
export type Track = z.infer<typeof TrackSchema>;

export const CompositionSchema = z.object({
  version: z.literal(COMPOSITION_VERSION),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  fps: z.number().positive().default(30),
  background: z.string().default('black'),
  tracks: z.array(TrackSchema).default([]),
});
export type Composition = z.infer<typeof CompositionSchema>;

// ─── Factories & id helpers ──────────────────────────────────────────────────

export function makeClipId(): string {
  return `clip_${randomBytes(4).toString('hex')}`;
}

export function makeTrackId(): string {
  return `trk_${randomBytes(4).toString('hex')}`;
}

/** A fresh empty composition at the given (or default 1080p30) canvas. */
export function emptyComposition(
  canvas: Partial<Pick<Composition, 'width' | 'height' | 'fps' | 'background'>> = {},
): Composition {
  return CompositionSchema.parse({ version: COMPOSITION_VERSION, tracks: [], ...canvas });
}

// ─── Derived geometry (used by the reducer and the export compiler) ──────────

/** On-timeline duration of a clip in seconds. */
export function clipDuration(clip: Clip): number {
  return clip.kind === 'media' ? clip.sourceOutSec - clip.sourceInSec : clip.durationSec;
}

/** Timeline time at which a clip ends (exclusive). */
export function clipEndSec(clip: Clip): number {
  return clip.startSec + clipDuration(clip);
}

/** Latest end time across every clip on every track — the composition length. */
export function compositionDuration(comp: Composition): number {
  let end = 0;
  for (const track of comp.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clipEndSec(clip));
    }
  }
  return end;
}

/** Find a clip (and its track) anywhere in the composition by id. */
export function findClip(
  comp: Composition,
  clipId: string,
): { track: Track; clip: Clip; index: number } | null {
  for (const track of comp.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index !== -1) {
      const clip = track.clips[index];
      if (clip) return { track, clip, index };
    }
  }
  return null;
}
