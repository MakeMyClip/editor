import { z } from 'zod';
import {
  AnchorSchema,
  type Composition,
  clipEndSec,
  makeClipId,
  TransitionKindSchema,
} from './composition.js';
import { applyOps, type CompositionOp, colorClip, mediaClip, textClip, videoTrack } from './ops.js';
import type { MediaId } from './schema.js';

/**
 * The VERB layer — a small, natural-language-shaped editing vocabulary that the
 * agent and the `clip ui` emit, lowered to the wire-level `CompositionOp`s the
 * reducer applies. Verbs exist so the impure parts of an edit — ingesting a file
 * to learn its id/duration, minting clip ids, choosing an append point — live
 * OUTSIDE the pure `applyOp` reducer, in `lowerVerb`. The agent and `clip ui`
 * emit verbs through `applyVerbs`; the CLI builds the same ops directly through
 * `mutateComposition` (and shares `trackEnd`/`ensureTrack` here). Either way every
 * edit lands on one op-aware, undoable document — not the legacy file-tools that
 * bypassed it.
 *
 * Per-field `.describe()` text is surfaced to the model by the AI SDK, so the
 * verb schema doubles as the agent's tool documentation.
 */
export const CompositionVerbSchema = z.discriminatedUnion('verb', [
  z.object({
    verb: z.literal('add_media'),
    id: z
      .string()
      .optional()
      .describe(
        'Optional clip id — supply one to reference this clip in a later verb of the SAME batch.',
      ),
    path: z.string().describe('Absolute or workspace-relative path to a video/audio/image file.'),
    track: z
      .string()
      .optional()
      .describe('Track id to place it on (default: the main video track).'),
    startSec: z
      .number()
      .nonnegative()
      .optional()
      .describe('Timeline start; default appends after the last clip.'),
    sourceInSec: z
      .number()
      .nonnegative()
      .optional()
      .describe('Trim in-point within the source (default 0).'),
    sourceOutSec: z
      .number()
      .positive()
      .optional()
      .describe('Trim out-point within the source (default the full duration).'),
  }),
  z.object({
    verb: z.literal('add_text'),
    id: z
      .string()
      .optional()
      .describe(
        'Optional clip id — supply one to reference this clip in a later verb of the SAME batch.',
      ),
    text: z.string().min(1).describe('The text to show.'),
    durationSec: z.number().positive().describe('How long the text is on screen.'),
    track: z.string().optional(),
    startSec: z
      .number()
      .nonnegative()
      .optional()
      .describe('Timeline start; default appends after the last clip.'),
    fontSize: z.number().int().positive().optional(),
    color: z.string().optional(),
    background: z
      .string()
      .nullable()
      .optional()
      .describe('Box color behind the text, or null for none.'),
    anchor: AnchorSchema.optional(),
  }),
  z.object({
    verb: z.literal('add_color'),
    id: z
      .string()
      .optional()
      .describe(
        'Optional clip id — supply one to reference this clip in a later verb of the SAME batch.',
      ),
    durationSec: z.number().positive(),
    color: z.string().optional().describe('Card color (default black).'),
    track: z.string().optional(),
    startSec: z.number().nonnegative().optional(),
  }),
  z.object({
    verb: z.literal('trim'),
    clipId: z.string(),
    sourceInSec: z.number().nonnegative().optional(),
    sourceOutSec: z.number().positive().optional(),
  }),
  z.object({
    verb: z.literal('move'),
    clipId: z.string(),
    startSec: z.number().nonnegative().optional().describe('New timeline start.'),
    toTrack: z.string().optional().describe('Move the clip to this track.'),
  }),
  z.object({
    verb: z.literal('split'),
    clipId: z.string(),
    atSec: z.number().describe('Timeline time to cut at (must fall inside the clip).'),
  }),
  z.object({ verb: z.literal('remove'), clipId: z.string() }),
  z.object({
    verb: z.literal('transition'),
    afterClipId: z
      .string()
      .describe('Add a transition after this clip, into the one that follows it.'),
    kind: TransitionKindSchema.optional(),
    durationSec: z.number().positive().max(10).optional(),
    track: z.string().optional(),
  }),
  z.object({
    verb: z.literal('set_transform'),
    clipId: z.string(),
    scale: z.number().positive().optional(),
    x: z.number().optional().describe('Horizontal center in [0,1].'),
    y: z.number().optional().describe('Vertical center in [0,1].'),
    rotationDeg: z.number().optional(),
    opacity: z.number().min(0).max(1).optional(),
  }),
]);
export type CompositionVerb = z.infer<typeof CompositionVerbSchema>;
export type CompositionVerbKind = CompositionVerb['verb'];

/** The impure capabilities `lowerVerb` needs — supplied by the I/O layer so the
 *  lowering stays unit-testable with stubs. */
export interface VerbContext {
  /** Register a media file and report its id + duration (wraps the ingest tool). */
  ingest: (path: string) => Promise<{ mediaId: MediaId; durationSec: number }>;
  /** Track a clip is placed on when the verb doesn't say. */
  defaultTrack: string;
}

const DEFAULT_TRACK = 'v0';

/** End time of the last clip on a track (0 if empty/missing) — the append point.
 *  Exported so the CLI shares one definition instead of a drifting copy. */
export function trackEnd(comp: Composition, trackId: string): number {
  const track = comp.tracks.find((t) => t.id === trackId);
  if (!track) return 0;
  return track.clips.reduce((end, c) => Math.max(end, clipEndSec(c)), 0);
}

/** Ops to create the named video track if it doesn't exist yet. */
export function ensureTrack(comp: Composition, trackId: string): CompositionOp[] {
  return comp.tracks.some((t) => t.id === trackId)
    ? []
    : [{ op: 'addTrack', track: videoTrack({ id: trackId }) }];
}

/**
 * Lower one verb to the `CompositionOp`s that carry it out, against the CURRENT
 * document. Impure (mints ids, may `ingest`), but it never mutates `comp` — the
 * caller applies the returned ops through `mutateComposition` so the edit is
 * validated, recorded, and undoable.
 */
export async function lowerVerb(
  comp: Composition,
  verb: CompositionVerb,
  ctx: VerbContext,
): Promise<CompositionOp[]> {
  switch (verb.verb) {
    case 'add_media': {
      const { mediaId, durationSec } = await ctx.ingest(verb.path);
      const trackId = verb.track ?? ctx.defaultTrack;
      const clip = mediaClip({
        id: verb.id ?? makeClipId(),
        mediaId,
        sourceInSec: verb.sourceInSec ?? 0,
        sourceOutSec: verb.sourceOutSec ?? durationSec,
        startSec: verb.startSec ?? trackEnd(comp, trackId),
      });
      return [...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }];
    }
    case 'add_text': {
      const trackId = verb.track ?? ctx.defaultTrack;
      const style: Record<string, unknown> = {};
      if (verb.fontSize !== undefined) style.fontSize = verb.fontSize;
      if (verb.color !== undefined) style.color = verb.color;
      if (verb.background !== undefined) style.background = verb.background;
      if (verb.anchor !== undefined) style.anchor = verb.anchor;
      const clip = textClip({
        id: verb.id ?? makeClipId(),
        text: verb.text,
        durationSec: verb.durationSec,
        startSec: verb.startSec ?? trackEnd(comp, trackId),
        style,
      });
      return [...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }];
    }
    case 'add_color': {
      const trackId = verb.track ?? ctx.defaultTrack;
      const clip = colorClip({
        id: verb.id ?? makeClipId(),
        color: verb.color,
        durationSec: verb.durationSec,
        startSec: verb.startSec ?? trackEnd(comp, trackId),
      });
      return [...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }];
    }
    case 'trim': {
      // An intent-free verb lowers to nothing; `mutateComposition`'s empty-batch
      // guard then makes it a true no-op (no rev bump, no spurious undo entry).
      if (verb.sourceInSec === undefined && verb.sourceOutSec === undefined) return [];
      return [
        {
          op: 'setTrim',
          clipId: verb.clipId,
          ...(verb.sourceInSec !== undefined ? { sourceInSec: verb.sourceInSec } : {}),
          ...(verb.sourceOutSec !== undefined ? { sourceOutSec: verb.sourceOutSec } : {}),
        },
      ];
    }
    case 'move': {
      if (verb.startSec === undefined && verb.toTrack === undefined) return [];
      return [
        {
          op: 'moveClip',
          clipId: verb.clipId,
          ...(verb.startSec !== undefined ? { startSec: verb.startSec } : {}),
          ...(verb.toTrack !== undefined ? { toTrackId: verb.toTrack } : {}),
        },
      ];
    }
    case 'split':
      return [{ op: 'splitClip', clipId: verb.clipId, atSec: verb.atSec, newClipId: makeClipId() }];
    case 'remove':
      return [{ op: 'removeClip', clipId: verb.clipId }];
    case 'transition':
      return [
        {
          op: 'addTransition',
          trackId: verb.track ?? ctx.defaultTrack,
          transition: {
            afterClipId: verb.afterClipId,
            kind: verb.kind ?? 'fade',
            durationSec: verb.durationSec ?? 1,
          },
        },
      ];
    case 'set_transform': {
      const transform: Record<string, number> = {};
      if (verb.scale !== undefined) transform.scale = verb.scale;
      if (verb.x !== undefined) transform.x = verb.x;
      if (verb.y !== undefined) transform.y = verb.y;
      if (verb.rotationDeg !== undefined) transform.rotationDeg = verb.rotationDeg;
      if (verb.opacity !== undefined) transform.opacity = verb.opacity;
      if (Object.keys(transform).length === 0) return []; // nothing to set — no-op.
      return [{ op: 'setTransform', clipId: verb.clipId, transform }];
    }
    default: {
      const _exhaustive: never = verb;
      throw new Error(`Unknown verb: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Lower a batch of verbs against the CURRENT doc, threading state so each verb
 *  sees the effect of the ones before it (e.g. a default append point shifts as
 *  earlier verbs add clips). Returns the flat op list to apply atomically. */
export async function lowerVerbs(
  comp: Composition,
  verbs: CompositionVerb[],
  ctx: VerbContext,
): Promise<CompositionOp[]> {
  let doc = comp;
  const all: CompositionOp[] = [];
  for (const verb of verbs) {
    const ops = await lowerVerb(doc, verb, ctx);
    all.push(...ops);
    doc = applyOps(doc, ops);
  }
  return all;
}

export { DEFAULT_TRACK as DEFAULT_VERB_TRACK };
