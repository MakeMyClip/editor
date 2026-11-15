import { z } from 'zod';
import { clipFraming, type Framing, videoLayers } from './compile.js';
import {
  type Clip,
  type Composition,
  type Fit,
  FitSchema,
  findClip,
  type Transform,
} from './composition.js';
import { type CompositionOp, CompositionOpError } from './ops.js';

/**
 * Reframing: change the canvas shape (9:16, 1:1, …) and how media fill it, and
 * frame single clips (fit, zoom, position). Pure planners that return ops, shared
 * by the `reframe` / `set_framing` verbs and the `clip timeline reframe` /
 * `framing` CLI commands, so every surface makes the same edit.
 */

export const AspectSchema = z.enum(['16:9', '9:16', '1:1', '4:5']);
export type Aspect = z.infer<typeof AspectSchema>;

/** `fit` for one clip: a fit of its own, or `inherit` to follow the canvas again. */
export const FramingFitSchema = z.enum([...FitSchema.options, 'inherit']);
export type FramingFit = z.infer<typeof FramingFitSchema>;

/** Zoom range. Export scales before it crops, so its cost grows with the square
 *  of the zoom; past 4 a 1080p export runs several times slower than realtime. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

const RATIOS: Record<Aspect, readonly [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:5': [4, 5],
};

export class ReframeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReframeError';
  }
}

export interface ReframeRequest {
  aspect?: Aspect;
  width?: number;
  height?: number;
  fit?: Fit;
  x?: number;
  y?: number;
}

export interface ReframePlan {
  ops: CompositionOp[];
  canvas: { width: number; height: number; fit: Fit };
  /** Media clips whose position the plan changes. */
  clipIds: string[];
}

export interface FramingRequest {
  clipId: string;
  fit?: FramingFit;
  scale?: number;
  x?: number;
  y?: number;
  reset?: boolean;
}

/** The canvas for an aspect, keeping the current short side (so 1920x1080 at
 *  9:16 is 1080x1920), with both sides even for the encoder. */
export function canvasFor(comp: Composition, aspect: Aspect): { width: number; height: number } {
  const [w, h] = RATIOS[aspect];
  const short = even(Math.min(comp.width, comp.height));
  return w >= h
    ? { width: even((short * w) / h), height: short }
    : { width: short, height: even((short * h) / w) };
}

/**
 * Ops that set the canvas to a new shape and fit (cover by default), and, when
 * `x`/`y` are given, position every media clip on the picture track. Only what
 * changes is emitted; an empty list means the document already matches.
 */
export function planReframe(comp: Composition, request: ReframeRequest): ReframePlan {
  const { width, height } = targetCanvas(comp, request);
  const fit = request.fit ?? 'cover';
  assertUnit('x', request.x);
  assertUnit('y', request.y);

  const ops: CompositionOp[] = [];
  const canvas: Extract<CompositionOp, { op: 'setCanvas' }> = { op: 'setCanvas' };
  if (width !== comp.width) canvas.width = width;
  if (height !== comp.height) canvas.height = height;
  if (fit !== comp.fit) canvas.fit = fit;
  if (Object.keys(canvas).length > 1) ops.push(canvas);

  const clipIds: string[] = [];
  const picture = videoLayers(comp).picture;
  if (picture && (request.x !== undefined || request.y !== undefined)) {
    for (const clip of picture.clips) {
      if (clip.kind !== 'media') continue;
      const transform: Partial<Transform> = {};
      if (request.x !== undefined && request.x !== (clip.transform?.x ?? 0.5)) {
        transform.x = request.x;
      }
      if (request.y !== undefined && request.y !== (clip.transform?.y ?? 0.5)) {
        transform.y = request.y;
      }
      if (Object.keys(transform).length === 0) continue;
      ops.push({ op: 'setTransform', clipId: clip.id, transform });
      clipIds.push(clip.id);
    }
  }
  return { ops, canvas: { width, height, fit }, clipIds };
}

/**
 * Ops that frame one media clip: its own fit (or `inherit` to follow the canvas
 * again), zoom and position. `reset` starts from no transform. Only what changes
 * is emitted.
 */
export function planFraming(comp: Composition, request: FramingRequest): CompositionOp[] {
  const found = findClip(comp, request.clipId);
  if (!found) throw new CompositionOpError(`No clip "${request.clipId}" in composition.`);
  const { clip } = found;
  if (clip.kind !== 'media') {
    throw new CompositionOpError(
      `Clip "${clip.id}" is a ${clip.kind} clip; only media clips can be framed. Place text with its anchor.`,
    );
  }
  if (request.scale !== undefined && !(request.scale >= MIN_ZOOM && request.scale <= MAX_ZOOM)) {
    throw new ReframeError(
      `Zoom must be between ${MIN_ZOOM} and ${MAX_ZOOM}, got ${request.scale}.`,
    );
  }
  assertUnit('x', request.x);
  assertUnit('y', request.y);

  const base = request.reset ? undefined : clip.transform;
  const patch: Partial<Transform> = {};
  if (request.fit !== undefined && request.fit !== 'inherit' && request.fit !== base?.fit) {
    patch.fit = request.fit;
  }
  if (request.scale !== undefined && request.scale !== (base?.scale ?? 1)) {
    patch.scale = request.scale;
  }
  if (request.x !== undefined && request.x !== (base?.x ?? 0.5)) patch.x = request.x;
  if (request.y !== undefined && request.y !== (base?.y ?? 0.5)) patch.y = request.y;

  const dropFit = request.fit === 'inherit' && base?.fit !== undefined;
  if (!request.reset && !dropFit) {
    return Object.keys(patch).length > 0
      ? [{ op: 'setTransform', clipId: clip.id, transform: patch }]
      : [];
  }
  // setTransform merges, so removing a key takes a clear and a rewrite of the rest.
  const ops: CompositionOp[] = [];
  if (clip.transform !== undefined) ops.push({ op: 'clearTransform', clipId: clip.id });
  const kept: Partial<Transform> = {};
  if (base && dropFit) {
    const { fit: _dropped, ...rest } = base;
    Object.assign(kept, rest);
  }
  const transform = { ...kept, ...patch };
  if (Object.keys(transform).length > 0) {
    ops.push({ op: 'setTransform', clipId: clip.id, transform });
  }
  return ops;
}

/**
 * A media clip's framing when it differs from the canvas default (the canvas
 * fit, centered, unzoomed), for read-backs: the canvas fit is reported once, not
 * repeated on every clip.
 */
export function ownFraming(comp: Composition, clip: Clip): Framing | undefined {
  if (clip.kind !== 'media') return undefined;
  const f = clipFraming(comp, clip);
  return f.fit === comp.fit && f.scale === 1 && f.x === 0.5 && f.y === 0.5 ? undefined : f;
}

function targetCanvas(
  comp: Composition,
  request: ReframeRequest,
): { width: number; height: number } {
  const hasSize = request.width !== undefined || request.height !== undefined;
  if (request.aspect && hasSize) {
    throw new ReframeError('Give an aspect or a width and height, not both.');
  }
  if (request.aspect) return canvasFor(comp, request.aspect);
  const { width, height } = request;
  if (width === undefined || height === undefined) {
    throw new ReframeError('Give an aspect (16:9, 9:16, 1:1, 4:5) or both a width and a height.');
  }
  for (const [name, size] of [
    ['Width', width],
    ['Height', height],
  ] as const) {
    if (!Number.isInteger(size) || size < 2 || size % 2 !== 0) {
      throw new ReframeError(`${name} must be an even number of pixels, got ${size}.`);
    }
  }
  return { width, height };
}

function assertUnit(name: 'x' | 'y', value: number | undefined): void {
  if (value !== undefined && !(value >= 0 && value <= 1)) {
    throw new ReframeError(
      `${name} must be between 0 and 1 (0 = ${name === 'x' ? 'left' : 'top'}, 0.5 = center, 1 = ${name === 'x' ? 'right' : 'bottom'}), got ${value}.`,
    );
  }
}

function even(size: number): number {
  return Math.max(2, Math.round(size / 2) * 2);
}
