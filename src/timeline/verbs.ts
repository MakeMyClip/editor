import { z } from 'zod';
import {
  captionSideMargin,
  DEFAULT_CAPTION_TRACK,
  DEFAULT_CAPTION_WORDS,
  planCaptions,
} from './captions.js';
import { ColorSchema } from './color.js';
import type { MediaInfo } from './compile.js';
import {
  AnchorSchema,
  type Composition,
  clipEndSec,
  FitSchema,
  type MediaClip,
  makeClipId,
  TargetLufsSchema,
  type TextStyle,
  TransitionKindSchema,
} from './composition.js';
import { applyOps, type CompositionOp, colorClip, mediaClip, textClip, videoTrack } from './ops.js';
import {
  AspectSchema,
  FramingFitSchema,
  MAX_ZOOM,
  MIN_ZOOM,
  planFraming,
  planReframe,
} from './reframe.js';
import { MAIN_TIMELINE, type MediaId, TimelineIdSchema } from './schema.js';
import { checkShortTimelines, planShort, type SpeechLevelsLookup } from './shorts.js';
import { SensitivitySchema, type SilenceCut } from './silence.js';
import {
  clipWords,
  findRetakes,
  planWordCut,
  type Transcript,
  TranscriptError,
} from './transcript.js';

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
const EDITABLE_VERB_SCHEMAS = [
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
    color: ColorSchema.optional().describe(
      'Card color: a name like black or white, or hex like #ffcc00 (default black).',
    ),
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
    verb: z.literal('remove_silence'),
    clipId: z
      .string()
      .describe(
        'Media clip to cut the pauses out of. It is split into back-to-back sub-clips that keep the speech, and later clips on its track move up.',
      ),
    sensitivity: SensitivitySchema.optional(),
  }),
  z.object({
    verb: z.literal('cut_words'),
    clipId: z.string().describe('Media clip to cut the words out of.'),
    fromIndex: z
      .number()
      .int()
      .nonnegative()
      .describe('First word to cut: its `index` from timeline_transcript.'),
    toIndex: z
      .number()
      .int()
      .nonnegative()
      .describe('Last word to cut (inclusive). Later clips on the track move up.'),
    transcriptId: z
      .string()
      .describe(
        'The `transcriptId` from the timeline_transcript call the indices came from; the cut is refused if the clip was transcribed again since.',
      ),
  }),
  z.object({
    verb: z.literal('remove_retakes'),
    clipId: z
      .string()
      .describe(
        'Media clip to cut repeated takes from: each phrase said twice in a row loses its earlier take (see `retakes` in timeline_transcript).',
      ),
    transcriptId: z
      .string()
      .optional()
      .describe('Optional `transcriptId` the retakes were read from; refused if it changed.'),
  }),
  z.object({
    verb: z.literal('caption_speech'),
    clipId: z
      .string()
      .optional()
      .describe(
        'Media clip to caption. Default: every media clip whose source has a transcript, replacing the whole caption track.',
      ),
    transcriptId: z
      .string()
      .optional()
      .describe(
        'Optional `transcriptId` (with clipId) the words were read from; refused if it changed.',
      ),
    maxWords: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe(
        `Most words per caption (default ${DEFAULT_CAPTION_WORDS}); 1 shows one word at a time. A pause or a sentence end also starts a new caption.`,
      ),
    track: z
      .string()
      .optional()
      .describe(`Caption track id (default "${DEFAULT_CAPTION_TRACK}"), kept above the video.`),
    fontSize: z.number().int().positive().optional(),
    color: z.string().optional().describe('Text color (default white).'),
    background: z
      .string()
      .nullable()
      .optional()
      .describe('Box color behind the text (default black@0.6), or null for none.'),
    anchor: AnchorSchema.optional().describe('Where captions sit (default bottom-center).'),
    margin: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'How far, in pixels, captions keep from the bottom (or top) edge. Default: a quarter of the height on a portrait canvas, clear of the Shorts, Reels and TikTok overlays; 40 otherwise.',
      ),
  }),
  z.object({
    verb: z.literal('reframe'),
    aspect: AspectSchema.optional().describe(
      'Output shape: 9:16 (vertical: Shorts, Reels, TikTok), 1:1, 4:5 (feed) or 16:9. Keeps the canvas short side, so 1920x1080 becomes 1080x1920.',
    ),
    width: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Exact canvas width in pixels (even), with height, instead of aspect.'),
    height: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Exact canvas height in pixels (even), with width, instead of aspect.'),
    fit: FitSchema.optional().describe(
      'cover (default): fill the frame and crop what overflows. contain: show the whole picture with bars.',
    ),
    x: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Horizontal position for every media clip now on the timeline: 0 shows the left edge of the source, 0.5 the center, 1 the right edge. Clips added later start centered; frame them with set_framing.',
      ),
    y: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Vertical position for every media clip now on the timeline: 0 top, 1 bottom.'),
  }),
  z.object({
    verb: z.literal('set_framing'),
    clipId: z.string().describe('Media clip to frame.'),
    fit: FramingFitSchema.optional().describe(
      "This clip's fit: cover fills the frame, contain shows all of it, inherit follows the canvas again.",
    ),
    scale: z
      .number()
      .min(MIN_ZOOM)
      .max(MAX_ZOOM)
      .optional()
      .describe('Zoom: 1 = fitted size, 1.3 = a punch-in, below 1 = smaller with bars.'),
    x: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Horizontal position: 0 shows the left edge of the source, 0.5 center, 1 right.'),
    y: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Vertical position: 0 top, 0.5 center, 1 bottom.'),
    reset: z
      .boolean()
      .optional()
      .describe('Start from the canvas default (its fit, centered, unzoomed) before the rest.'),
  }),
  z.object({
    verb: z.literal('set_loudness'),
    targetLufs: TargetLufsSchema.nullable().describe(
      'Normalize the exported mp4 to this integrated loudness in LUFS: -14 for YouTube, Shorts, Reels and TikTok, -16 for podcasts. null turns it off. Applies to mp4 export only.',
    ),
  }),
  z.object({
    verb: z.literal('make_short'),
    ranges: z
      .array(
        z.object({
          clipId: z
            .string()
            .describe(
              'A media clip on the source timeline whose transcript the indices come from.',
            ),
          fromIndex: z
            .number()
            .int()
            .nonnegative()
            .describe('First word of the range: its `index` from timeline_transcript.'),
          toIndex: z.number().int().nonnegative().describe('Last word of the range (inclusive).'),
          transcriptId: z
            .string()
            .optional()
            .describe(
              'The `transcriptId` the indices were read from; refused if the clip was transcribed again since.',
            ),
        }),
      )
      .min(1)
      .max(20)
      .describe(
        'Word ranges, played in this order (a later moment can open the short as its hook). Pick whole sentences from the timeline_transcript sentence outline; 15–60 s in all is typical. A range that starts or ends mid-sentence is made anyway, with a warning.',
      ),
    source: TimelineIdSchema.optional().describe(
      'Timeline to cut from (default "main"). Its silence and retake cuts carry into the short.',
    ),
    aspect: AspectSchema.optional().describe('Output shape (default 9:16).'),
    x: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Horizontal position of the picture: 0 shows the left edge of the source, 0.5 the center, 1 the right edge. Put the speaker in frame.',
      ),
    y: z.number().min(0).max(1).optional().describe('Vertical position: 0 top, 1 bottom.'),
    captions: z
      .boolean()
      .optional()
      .describe('Burn in captions from the transcript (default true).'),
    maxWords: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe(
        `Most words per caption (default ${DEFAULT_CAPTION_WORDS}); 1 shows one word at a time.`,
      ),
    targetLufs: TargetLufsSchema.nullable()
      .optional()
      .describe(
        'Export loudness in LUFS (default -14, for Shorts, Reels and TikTok); null for off.',
      ),
    replace: z
      .boolean()
      .optional()
      .describe('Rebuild this timeline when it already holds a short (default: refuse).'),
  }),
  z.object({
    verb: z.literal('transition'),
    afterClipId: z
      .string()
      .describe('Add a transition after this clip, into the one that follows it.'),
    kind: TransitionKindSchema.optional(),
    durationSec: z.number().positive().max(10).optional(),
    track: z.string().optional(),
  }),
] as const;

/**
 * `set_transform` is split out from the editable set: it can rotate a clip or
 * make it partly transparent, which export refuses (see `assertCompilable` in
 * compile.ts), so the MCP server omits it and offers `set_framing` for fit, zoom
 * and position. The op layer still accepts it.
 */
const TRANSFORM_VERB_SCHEMA = z.object({
  verb: z.literal('set_transform'),
  clipId: z.string(),
  scale: z.number().positive().optional(),
  x: z.number().optional().describe('Horizontal center in [0,1].'),
  y: z.number().optional().describe('Vertical center in [0,1].'),
  rotationDeg: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
});

/** Renderable editing verbs only — no `set_transform`. What the MCP
 *  `timeline_edit` accepts, so it can't author a doc the compiler refuses. */
export const EditableVerbSchema = z.discriminatedUnion('verb', EDITABLE_VERB_SCHEMAS);

/** The full verb vocabulary, including `set_transform` (accepted by the CLI/op layer). */
export const CompositionVerbSchema = z.discriminatedUnion('verb', [
  ...EDITABLE_VERB_SCHEMAS,
  TRANSFORM_VERB_SCHEMA,
]);
export type CompositionVerb = z.infer<typeof CompositionVerbSchema>;
export type CompositionVerbKind = CompositionVerb['verb'];

/** The impure capabilities `lowerVerb` needs — supplied by the I/O layer so the
 *  lowering stays unit-testable with stubs. */
export interface VerbContext {
  /** Register a media file and report its id + duration (wraps the ingest tool). */
  ingest: (path: string) => Promise<{ mediaId: MediaId; durationSec: number }>;
  /** Plan a silence cut for a media clip (runs FFmpeg's silencedetect). */
  analyzeSilence: (comp: Composition, clipId: string, sensitivity?: number) => Promise<SilenceCut>;
  /** A media clip, its source's STORED transcript (the one whose word indices
   *  the caller saw) and the media the timeline uses; throws if it hasn't been
   *  transcribed. */
  transcript: (
    comp: Composition,
    clipId: string,
    transcriptId?: string,
  ) => Promise<{ clip: MediaClip; transcript: Transcript; media: Map<MediaId, MediaInfo> }>;
  /** Read another timeline of the workspace (make_short's source). */
  readTimeline: (timeline: string) => Promise<Composition>;
  /** A media clip's source audio levels around a time (runs FFmpeg), for
   *  placing a short's edges in pauses; null when the source has no sound. */
  speechLevels: SpeechLevelsLookup;
  /** Track a clip is placed on when the verb doesn't say. */
  defaultTrack: string;
  /** The timeline being edited (default `main`); `applyVerbs` sets it. */
  timeline?: string;
  /** Hears what a verb did that the caller may not have meant (e.g. a short
   *  cut mid-sentence); `applyVerbs` collects them. */
  warn?: (message: string) => void;
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
    case 'remove_silence': {
      // Nothing to cut lowers to an empty batch, which is a true no-op.
      const cut = await ctx.analyzeSilence(comp, verb.clipId, verb.sensitivity);
      return cut.op ? [cut.op] : [];
    }
    case 'cut_words': {
      const { clip, transcript, media } = await ctx.transcript(
        comp,
        verb.clipId,
        verb.transcriptId,
      );
      const op = planWordCut(
        comp,
        clip,
        transcript,
        [{ fromIndex: verb.fromIndex, toIndex: verb.toIndex }],
        { media },
      );
      if (!op) {
        throw new TranscriptError(
          `Words ${verb.fromIndex}..${verb.toIndex} aren't inside clip "${verb.clipId}".`,
        );
      }
      return [op];
    }
    case 'remove_retakes': {
      const { clip, transcript, media } = await ctx.transcript(
        comp,
        verb.clipId,
        verb.transcriptId,
      );
      const op = planWordCut(comp, clip, transcript, findRetakes(clipWords(transcript, clip)), {
        media,
      });
      return op ? [op] : [];
    }
    case 'caption_speech': {
      const style: Partial<TextStyle> = {};
      if (verb.fontSize !== undefined) style.fontSize = verb.fontSize;
      if (verb.color !== undefined) style.color = verb.color;
      if (verb.background !== undefined) style.background = verb.background;
      if (verb.anchor !== undefined) style.anchor = verb.anchor;
      if (verb.margin !== undefined) style.margin = { x: captionSideMargin(comp), y: verb.margin };
      const plan = await planCaptions(
        comp,
        {
          clipId: verb.clipId,
          transcriptId: verb.transcriptId,
          maxWords: verb.maxWords,
          track: verb.track,
          style,
        },
        (clipId, transcriptId) => ctx.transcript(comp, clipId, transcriptId),
      );
      return plan.ops;
    }
    case 'reframe':
      return planReframe(comp, verb).ops;
    case 'set_framing':
      return planFraming(comp, verb);
    case 'set_loudness':
      return (comp.loudness?.targetLufs ?? null) === verb.targetLufs
        ? []
        : [{ op: 'setLoudness', targetLufs: verb.targetLufs }];
    case 'make_short': {
      const sourceId = verb.source ?? MAIN_TIMELINE;
      checkShortTimelines(ctx.timeline ?? MAIN_TIMELINE, sourceId);
      const plan = await planShort(
        comp,
        await ctx.readTimeline(sourceId),
        {
          ranges: verb.ranges,
          aspect: verb.aspect,
          x: verb.x,
          y: verb.y,
          captions: verb.captions,
          maxWords: verb.maxWords,
          targetLufs: verb.targetLufs,
          replace: verb.replace,
        },
        { transcript: ctx.transcript, levels: ctx.speechLevels },
      );
      for (const warning of plan.warnings) ctx.warn?.(warning);
      return plan.ops;
    }
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
