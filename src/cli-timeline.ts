import { appendOp } from './session/store.js';
import {
  CaptionError,
  captionSideMargin,
  DEFAULT_CAPTION_WORDS,
  planCaptions,
} from './timeline/captions.js';
import { invalidColorMessage, isColor } from './timeline/color.js';
import {
  buildFrameAtPlan,
  checkExportable,
  clipFraming,
  compileTimeline,
} from './timeline/compile.js';
import {
  AnchorSchema,
  type Clip,
  type Composition,
  clipDuration,
  clipEndSec,
  clipsAtTime,
  compositionDuration,
  emptyComposition,
  type Fit,
  FitSchema,
  findClip,
  LOUDNESS_MAX_LUFS,
  LOUDNESS_MIN_LUFS,
  makeClipId,
  TargetLufsSchema,
  type TextStyle,
} from './timeline/composition.js';
import {
  deleteTimeline,
  listTimelines,
  mutateComposition,
  NoTimelineError,
  readComposition,
  readDocOpLog,
  redoDocOp,
  resetComposition,
  TimelineIdError,
  undoLastDocOp,
} from './timeline/document-store.js';
import {
  exportInterchange,
  InterchangeFormatSchema,
  interchangeExtension,
  interchangeFormatFor,
} from './timeline/interchange.js';
import { buildMediaMap, buildMediaRefs } from './timeline/media-registry.js';
import { colorClip, mediaClip, textClip } from './timeline/ops.js';
import { measureSpeechLevels } from './timeline/pauses.js';
import {
  AspectSchema,
  type FramingFit,
  FramingFitSchema,
  ownFraming,
  planFraming,
  planReframe,
} from './timeline/reframe.js';
import { reviewCuts } from './timeline/review.js';
import { exportTimelines, runPlan } from './timeline/run-plan.js';
import { MAIN_TIMELINE, TimelineIdSchema } from './timeline/schema.js';
import { checkShortTimelines, planShort, type ShortRange } from './timeline/shorts.js';
import { analyzeSilence, DEFAULT_SENSITIVITY, SensitivitySchema } from './timeline/silence.js';
import {
  clipWords,
  findRetakes,
  planWordCut,
  storedTranscriptForClip,
  timelineOutline,
  transcribeClip,
} from './timeline/transcript.js';
import { DEFAULT_VERB_TRACK as DEFAULT_TRACK, ensureTrack, trackEnd } from './timeline/verbs.js';
import { ingest } from './tools/ingest.js';
import { getWorkspace, newOutputPath, resolveInput } from './workspace.js';

const TIMELINE_HELP = `clip timeline — build and export a non-destructive composition

Every command works on the main timeline unless --timeline <id> names another
(a short made with \`short\` is a timeline of its own).

  clip timeline new [--width W --height H --fps F --background C --fit contain|cover]
  clip timeline add-media <path> [<inSec> <outSec>] [--start S] [--track T]
  clip timeline add-text <text> <durationSec> [--start S] [--track T] [--font N --color C --anchor A --background C]
  clip timeline add-color <durationSec> [--color C] [--start S] [--track T]
  clip timeline transition <afterClipId> [<kind>] [<durationSec>] [--track T]
  clip timeline trim <clipId> <inSec> <outSec>
  clip timeline move <clipId> <startSec> [--track T]
  clip timeline split <clipId> <atSec>
  clip timeline remove <clipId>
  clip timeline silence <clipId> [--sensitivity 0..1] [--dry-run]
  clip timeline check [--sheet <output.jpg>]
  clip timeline transcribe [<clipId>] [--sentences] [--from S] [--to S] [--model <model.bin>] [--language <code>]
  clip timeline cut-words <clipId> <fromIndex> <toIndex> [--transcript <id>]
  clip timeline remove-retakes <clipId> [--dry-run] [--transcript <id>]
  clip timeline captions [<clipId>] [--words N] [--track T] [--font N --color C --anchor A --background C|none --margin PX] [--dry-run]
  clip timeline reframe <9:16|1:1|4:5|16:9|WxH> [--fit cover|contain] [--x 0..1] [--y 0..1] [--dry-run]
  clip timeline framing <clipId> [--fit cover|contain|inherit] [--scale 0.1..4] [--x 0..1] [--y 0..1] [--reset]
  clip timeline loudness <-14|-16|LUFS|off>
  clip timeline short <id> <clipId> <from> <to> [<clipId> <from> <to> …] [--source T] [--aspect 9:16|1:1|4:5|16:9] [--x 0..1] [--y 0..1] [--words N] [--no-captions] [--loudness LUFS|off] [--replace] [--dry-run]
  clip timeline list
  clip timeline delete <id>
  clip timeline show
  clip timeline at <atSec>
  clip timeline frame <atSec> [<output>]
  clip timeline undo
  clip timeline redo
  clip timeline log
  clip timeline export [<output>] [--format mp4|fcpxml|xmeml]
  clip timeline export --all <dir>      (every short, as <dir>/<id>.mp4)
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string>;
}

/** Flags that take no value, so they don't swallow the next argument. */
const BOOLEAN_FLAGS = new Set(['all', 'dry-run', 'reset', 'no-captions', 'replace', 'sentences']);

function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a.startsWith('--') && BOOLEAN_FLAGS.has(a.slice(2))) {
      flags[a.slice(2)] = 'true';
    } else if (a.startsWith('--')) {
      flags[a.slice(2)] = args[i + 1] ?? '';
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`Expected a number, got "${value}".`);
  return n;
}

/** A number flag, or undefined when the flag wasn't given. */
function optionalNum(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === '' || Number.isNaN(n)) throw new Error(`--${name} needs a number.`);
  return n;
}

function colorFlag(name: string, value: string | undefined): string | undefined {
  if (value === undefined || isColor(value)) return value;
  throw new Error(`--${name} ${invalidColorMessage(value)}`);
}

function fitFlag(value: string | undefined): Fit | undefined {
  if (value === undefined) return undefined;
  const parsed = FitSchema.safeParse(value);
  if (!parsed.success) throw new Error(`--fit must be cover or contain, got "${value}".`);
  return parsed.data;
}

function framingFitFlag(value: string | undefined): FramingFit | undefined {
  if (value === undefined) return undefined;
  const parsed = FramingFitSchema.safeParse(value);
  if (!parsed.success) throw new Error(`--fit must be cover, contain or inherit, got "${value}".`);
  return parsed.data;
}

function timelineId(value: string): string {
  const parsed = TimelineIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new TimelineIdError(
      `Invalid timeline id "${value}". ${parsed.error.issues[0]?.message ?? ''}`.trim(),
    );
  }
  return parsed.data;
}

/** Timeline time as m:ss, or h:mm:ss from an hour. */
function clock(sec: number): string {
  const whole = Math.floor(sec);
  const s = String(whole % 60).padStart(2, '0');
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function wordIndex(value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isInteger(n) || n < 0) {
    throw new Error(`A word index is a whole number from 0, got "${value}".`);
  }
  return n;
}

/** `off`, or a loudness target within the export's range. */
function loudnessValue(value: string, usage: string): number | null {
  if (value === 'off') return null;
  const parsed = TargetLufsSchema.safeParse(Number(value));
  if (!parsed.success) {
    throw new Error(
      `Loudness must be off or a LUFS value from ${LOUDNESS_MIN_LUFS} to ${LOUDNESS_MAX_LUFS}, got "${value}". ${usage}`,
    );
  }
  return parsed.data;
}

/** A short, human-readable label for a clip (for `show` / `at`). */
function clipLabel(clip: Clip): string {
  switch (clip.kind) {
    case 'media':
      return clip.mediaId;
    case 'text':
      return clip.text.length > 30 ? `${clip.text.slice(0, 30)}…` : clip.text;
    case 'color':
      return clip.color;
  }
}

export async function runTimeline(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const [sub, ...positional] = parsed.positional;
  const { flags } = parsed;
  const timeline = flags.timeline !== undefined ? timelineId(flags.timeline) : MAIN_TIMELINE;

  switch (sub) {
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(TIMELINE_HELP);
      return;

    case 'new': {
      const comp = await resetComposition(
        emptyComposition({
          width: flags.width ? num(flags.width, 1920) : undefined,
          height: flags.height ? num(flags.height, 1080) : undefined,
          fps: flags.fps ? num(flags.fps, 30) : undefined,
          background: colorFlag('background', flags.background),
          fit: fitFlag(flags.fit),
        }),
        timeline,
      );
      out({
        created: true,
        timeline,
        width: comp.width,
        height: comp.height,
        fps: comp.fps,
        fit: comp.fit,
      });
      return;
    }

    case 'add-media': {
      const [path, inSec, outSec] = positional;
      if (!path) throw new Error('Usage: clip timeline add-media <path> [<inSec> <outSec>]');
      const resolved = resolveInput(path);
      const result = await ingest({ path: resolved });
      await appendOp({
        tool: 'ingest',
        args: { path: resolved },
        result: result as unknown as Record<string, unknown>,
      });

      const trackId = flags.track || DEFAULT_TRACK;
      const comp = await readComposition(timeline);
      const start = flags.start !== undefined ? num(flags.start, 0) : trackEnd(comp, trackId);
      const clip = mediaClip({
        id: makeClipId(),
        mediaId: result.mediaId,
        sourceInSec: num(inSec, 0),
        sourceOutSec: num(outSec, result.ref.durationSec),
        startSec: start,
      });
      await mutateComposition([...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }], {
        timeline,
      });
      out({ added: 'media', clipId: clip.id, mediaId: result.mediaId, trackId, startSec: start });
      return;
    }

    case 'add-text': {
      const [text, duration] = positional;
      if (!text || duration === undefined) {
        throw new Error('Usage: clip timeline add-text <text> <durationSec>');
      }
      const trackId = flags.track || DEFAULT_TRACK;
      const comp = await readComposition(timeline);
      const start = flags.start !== undefined ? num(flags.start, 0) : trackEnd(comp, trackId);
      const style: Record<string, unknown> = {};
      if (flags.font) style.fontSize = num(flags.font, 48);
      if (flags.color) style.color = flags.color;
      if (flags.background) style.background = flags.background;
      if (flags.anchor) style.anchor = flags.anchor;
      const clip = textClip({
        id: makeClipId(),
        text,
        durationSec: num(duration, 2),
        startSec: start,
        style,
      });
      await mutateComposition([...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }], {
        timeline,
      });
      out({ added: 'text', clipId: clip.id, trackId, startSec: start });
      return;
    }

    case 'add-color': {
      const [duration] = positional;
      if (duration === undefined) throw new Error('Usage: clip timeline add-color <durationSec>');
      const trackId = flags.track || DEFAULT_TRACK;
      const comp = await readComposition(timeline);
      const start = flags.start !== undefined ? num(flags.start, 0) : trackEnd(comp, trackId);
      const clip = colorClip({
        id: makeClipId(),
        color: colorFlag('color', flags.color),
        durationSec: num(duration, 2),
        startSec: start,
      });
      await mutateComposition([...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }], {
        timeline,
      });
      out({ added: 'color', clipId: clip.id, trackId, startSec: start });
      return;
    }

    case 'transition': {
      const [afterClipId, kind, duration] = positional;
      if (!afterClipId)
        throw new Error('Usage: clip timeline transition <afterClipId> [<kind>] [<durationSec>]');
      const trackId = flags.track || DEFAULT_TRACK;
      await mutateComposition(
        [
          {
            op: 'addTransition',
            trackId,
            transition: {
              afterClipId,
              kind: (kind as never) ?? 'fade',
              durationSec: num(duration, 1),
            },
          },
        ],
        { timeline },
      );
      out({ added: 'transition', afterClipId, kind: kind ?? 'fade', trackId });
      return;
    }

    case 'trim': {
      const [clipId, inSec, outSec] = positional;
      if (!clipId || inSec === undefined || outSec === undefined) {
        throw new Error('Usage: clip timeline trim <clipId> <inSec> <outSec>');
      }
      await mutateComposition(
        [{ op: 'setTrim', clipId, sourceInSec: num(inSec, 0), sourceOutSec: num(outSec, 0) }],
        { timeline },
      );
      out({ trimmed: clipId, sourceInSec: num(inSec, 0), sourceOutSec: num(outSec, 0) });
      return;
    }

    case 'move': {
      const [clipId, startSec] = positional;
      if (!clipId || startSec === undefined)
        throw new Error('Usage: clip timeline move <clipId> <startSec>');
      await mutateComposition(
        [
          {
            op: 'moveClip',
            clipId,
            startSec: num(startSec, 0),
            toTrackId: flags.track || undefined,
          },
        ],
        { timeline },
      );
      out({ moved: clipId, startSec: num(startSec, 0), trackId: flags.track || undefined });
      return;
    }

    case 'split': {
      const [clipId, atSec] = positional;
      if (!clipId || atSec === undefined)
        throw new Error('Usage: clip timeline split <clipId> <atSec>');
      const newClipId = makeClipId();
      await mutateComposition([{ op: 'splitClip', clipId, atSec: num(atSec, 0), newClipId }], {
        timeline,
      });
      out({ split: clipId, into: [clipId, newClipId], atSec: num(atSec, 0) });
      return;
    }

    case 'remove': {
      const [clipId] = positional;
      if (!clipId) throw new Error('Usage: clip timeline remove <clipId>');
      await mutateComposition([{ op: 'removeClip', clipId }], { timeline });
      out({ removed: clipId });
      return;
    }

    case 'silence': {
      const [clipId] = positional;
      if (!clipId) {
        throw new Error('Usage: clip timeline silence <clipId> [--sensitivity 0..1] [--dry-run]');
      }
      const parsed = SensitivitySchema.safeParse(num(flags.sensitivity, DEFAULT_SENSITIVITY));
      if (!parsed.success) {
        throw new Error(`--sensitivity must be between 0 and 1, got "${flags.sensitivity}".`);
      }
      const sensitivity = parsed.data;
      const comp = await readComposition(timeline);
      const cut = await analyzeSilence(comp, clipId, { media: await buildMediaMap(), sensitivity });
      const report = {
        clipId,
        sensitivity,
        silenceCount: cut.silenceCount,
        removedSec: cut.removedSec,
        keepRegions: cut.keepRegions,
      };
      if (cut.op?.op !== 'silenceCut') {
        out({ ...report, applied: false, message: 'No silence to remove at this sensitivity.' });
        return;
      }
      if (flags['dry-run']) {
        out({ ...report, applied: false, dryRun: true });
        return;
      }
      // Analysis read `comp` outside the write lock; reject if the doc moved since.
      const doc = await mutateComposition([cut.op], { expectedBaseRev: comp.rev, timeline });
      out({ ...report, applied: true, clipIds: [clipId, ...cut.op.newClipIds], rev: doc.rev });
      return;
    }

    case 'reframe': {
      const [shape] = positional;
      if (!shape) {
        throw new Error(
          'Usage: clip timeline reframe <9:16|1:1|4:5|16:9|WxH> [--fit cover|contain] [--x 0..1] [--y 0..1] [--dry-run]',
        );
      }
      const aspect = AspectSchema.safeParse(shape);
      const size = /^(\d+)x(\d+)$/.exec(shape);
      if (!aspect.success && !size) {
        throw new Error(`Unknown shape "${shape}": use 9:16, 1:1, 4:5, 16:9 or WIDTHxHEIGHT.`);
      }
      const comp = await readComposition(timeline);
      const plan = planReframe(comp, {
        ...(aspect.success
          ? { aspect: aspect.data }
          : { width: Number(size?.[1]), height: Number(size?.[2]) }),
        fit: fitFlag(flags.fit),
        x: optionalNum('x', flags.x),
        y: optionalNum('y', flags.y),
      });
      const report = { canvas: plan.canvas, clipIds: plan.clipIds };
      if (flags['dry-run'] || plan.ops.length === 0) {
        out({ ...report, applied: false, ...(flags['dry-run'] ? { dryRun: true } : {}) });
        return;
      }
      const doc = await mutateComposition(plan.ops, { expectedBaseRev: comp.rev, timeline });
      out({ ...report, applied: true, rev: doc.rev });
      return;
    }

    case 'framing': {
      const [clipId] = positional;
      if (!clipId) {
        throw new Error(
          'Usage: clip timeline framing <clipId> [--fit cover|contain|inherit] [--scale 0.1..4] [--x 0..1] [--y 0..1] [--reset]',
        );
      }
      const comp = await readComposition(timeline);
      const ops = planFraming(comp, {
        clipId,
        fit: framingFitFlag(flags.fit),
        scale: optionalNum('scale', flags.scale),
        x: optionalNum('x', flags.x),
        y: optionalNum('y', flags.y),
        reset: flags.reset === 'true',
      });
      if (ops.length === 0) {
        out({ clipId, applied: false, message: 'Nothing to change.' });
        return;
      }
      const doc = await mutateComposition(ops, { expectedBaseRev: comp.rev, timeline });
      const framed = findClip(doc, clipId);
      out({
        clipId,
        applied: true,
        framing: framed ? clipFraming(doc, framed.clip) : undefined,
        rev: doc.rev,
      });
      return;
    }

    case 'loudness': {
      const [value] = positional;
      const usage = 'Usage: clip timeline loudness <LUFS, e.g. -14 or -16 | off>';
      if (!value) throw new Error(usage);
      const targetLufs = loudnessValue(value, usage);
      const comp = await readComposition(timeline);
      if ((comp.loudness?.targetLufs ?? null) === targetLufs) {
        out({ loudness: comp.loudness, applied: false });
        return;
      }
      const doc = await mutateComposition([{ op: 'setLoudness', targetLufs }], {
        expectedBaseRev: comp.rev,
        timeline,
      });
      out({ loudness: doc.loudness, applied: true, rev: doc.rev });
      return;
    }

    case 'short': {
      const [id, ...rangeArgs] = positional;
      const usage =
        'Usage: clip timeline short <id> <clipId> <fromIndex> <toIndex> [<clipId> <fromIndex> <toIndex> …] ' +
        '[--source T] [--aspect 9:16|1:1|4:5|16:9] [--x 0..1] [--y 0..1] [--words N] [--no-captions] ' +
        '[--loudness LUFS|off] [--replace] [--dry-run]';
      if (!id || rangeArgs.length === 0 || rangeArgs.length % 3 !== 0) throw new Error(usage);
      const target = timelineId(id);
      if (flags.timeline !== undefined && timeline !== target) {
        throw new Error(
          `\`short\` builds the timeline named by its first argument ("${target}"), not --timeline. Use --source for the timeline to cut from.`,
        );
      }
      const sourceId = flags.source !== undefined ? timelineId(flags.source) : MAIN_TIMELINE;
      checkShortTimelines(target, sourceId);
      const ranges: ShortRange[] = [];
      for (let i = 0; i < rangeArgs.length; i += 3) {
        ranges.push({
          clipId: rangeArgs[i] ?? '',
          fromIndex: wordIndex(rangeArgs[i + 1]),
          toIndex: wordIndex(rangeArgs[i + 2]),
        });
      }
      const aspect = flags.aspect === undefined ? undefined : AspectSchema.safeParse(flags.aspect);
      if (aspect && !aspect.success) {
        throw new Error(`--aspect must be 9:16, 1:1, 4:5 or 16:9, got "${flags.aspect}".`);
      }
      const maxWords = num(flags.words, DEFAULT_CAPTION_WORDS);
      if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > 12) {
        throw new CaptionError(
          `--words must be a whole number from 1 to 12, got "${flags.words}".`,
        );
      }

      let current: Composition;
      try {
        current = await readComposition(target);
      } catch (err) {
        if (!(err instanceof NoTimelineError)) throw err;
        current = emptyComposition();
      }
      const media = await buildMediaMap();
      const plan = await planShort(
        current,
        await readComposition(sourceId),
        {
          ranges,
          aspect: aspect?.data,
          x: optionalNum('x', flags.x),
          y: optionalNum('y', flags.y),
          captions: flags['no-captions'] !== 'true',
          maxWords,
          targetLufs:
            flags.loudness === undefined ? undefined : loudnessValue(flags.loudness, usage),
          replace: flags.replace === 'true',
        },
        {
          transcript: (comp, clipId, transcriptId) =>
            storedTranscriptForClip(comp, clipId, media, transcriptId),
          levels: async (comp, clipId, aroundSec) => {
            const clip = findClip(comp, clipId)?.clip;
            const info = clip?.kind === 'media' ? media.get(clip.mediaId) : undefined;
            return info?.hasAudio ? measureSpeechLevels(info.path, aroundSec) : null;
          },
        },
      );
      const report = {
        timeline: target,
        source: sourceId,
        durationSec: plan.durationSec,
        pieces: plan.pieces,
        captions: plan.captions,
        warnings: plan.warnings,
      };
      if (flags['dry-run']) {
        out({ ...report, applied: false, dryRun: true });
        return;
      }
      // The source and transcripts were read outside the write lock; reject if
      // the short's timeline moved since.
      const doc = await mutateComposition(plan.ops, {
        expectedBaseRev: current.rev,
        timeline: target,
        create: true,
      });
      out({
        ...report,
        applied: true,
        canvas: { width: doc.width, height: doc.height, fit: doc.fit },
        loudness: doc.loudness,
        rev: doc.rev,
      });
      return;
    }

    case 'list':
      out({ timelines: await listTimelines() });
      return;

    case 'delete': {
      const [id] = positional;
      if (!id) throw new Error('Usage: clip timeline delete <id>');
      const target = timelineId(id);
      await deleteTimeline(target);
      out({ deleted: target });
      return;
    }

    case 'check': {
      const comp = await readComposition(timeline);
      const media = await buildMediaMap();
      const sheetPath = flags.sheet ? resolveInput(flags.sheet) : newOutputPath('cut-sheet', 'jpg');
      out(await reviewCuts(comp, media, sheetPath, getWorkspace()));
      return;
    }

    case 'transcribe': {
      const [clipId] = positional;
      const comp = await readComposition(timeline);
      const opts = {
        model: flags.model ? resolveInput(flags.model) : undefined,
        language: flags.language || undefined,
      };
      if (clipId && flags.sentences !== 'true') {
        out(await transcribeClip(comp, clipId, await buildMediaMap(), opts));
        return;
      }
      // One line per sentence, cheap to read and to `head`: no page limit here.
      const outline = await timelineOutline(comp, await buildMediaMap(), {
        ...opts,
        clipId,
        fromSec: optionalNum('from', flags.from),
        toSec: optionalNum('to', flags.to),
        maxBytes: Number.POSITIVE_INFINITY,
      });
      const lines = Object.entries(outline.transcriptIds).map(
        ([mediaId, id]) => `transcript ${mediaId}: ${id}`,
      );
      for (const s of outline.sentences) {
        // With more than one source, its media id, to match a transcript line.
        const source = s.mediaId ? `  ${s.mediaId}` : '';
        lines.push(
          `${clock(s.startSec)}  #${s.fromIndex}–${s.toIndex}  ${s.clipId}${source}  ${s.text}`,
        );
      }
      // `| head` closes the pipe early: that ends the listing, not with an error.
      process.stdout.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') throw err;
      });
      process.stdout.write(lines.length > 0 ? `${lines.join('\n')}\n` : '');
      return;
    }

    case 'cut-words':
    case 'remove-retakes': {
      const [clipId, from, to] = positional;
      const isCutWords = sub === 'cut-words';
      if (!clipId || (isCutWords && (from === undefined || to === undefined))) {
        throw new Error(
          isCutWords
            ? 'Usage: clip timeline cut-words <clipId> <fromIndex> <toIndex>'
            : 'Usage: clip timeline remove-retakes <clipId> [--dry-run]',
        );
      }
      const comp = await readComposition(timeline);
      const media = await buildMediaMap();
      const { clip, transcript } = await storedTranscriptForClip(
        comp,
        clipId,
        media,
        flags.transcript || undefined,
      );
      const ranges = isCutWords
        ? [{ fromIndex: num(from, 0), toIndex: num(to, 0) }]
        : findRetakes(clipWords(transcript, clip));
      const op = planWordCut(comp, clip, transcript, ranges, { media });
      if (!op) {
        out({ clipId, applied: false, ranges, message: 'Nothing to cut in this clip.' });
        return;
      }
      if (flags['dry-run']) {
        out({ clipId, applied: false, dryRun: true, ranges });
        return;
      }
      // The transcript was read outside the write lock; reject if the doc moved since.
      const doc = await mutateComposition([op], { expectedBaseRev: comp.rev, timeline });
      out({ clipId, applied: true, ranges, rev: doc.rev });
      return;
    }

    case 'captions': {
      const [clipId] = positional;
      const maxWords = num(flags.words, DEFAULT_CAPTION_WORDS);
      if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > 12) {
        throw new CaptionError(
          `--words must be a whole number from 1 to 12, got "${flags.words}".`,
        );
      }
      const style: Partial<TextStyle> = {};
      if (flags.font) style.fontSize = num(flags.font, 48);
      if (flags.color) style.color = flags.color;
      if (flags.background)
        style.background = flags.background === 'none' ? null : flags.background;
      if (flags.anchor) style.anchor = AnchorSchema.parse(flags.anchor);
      const comp = await readComposition(timeline);
      const margin = optionalNum('margin', flags.margin);
      if (margin !== undefined) {
        if (!Number.isInteger(margin) || margin < 0) {
          throw new CaptionError(
            `--margin must be a whole number of pixels, got "${flags.margin}".`,
          );
        }
        style.margin = { x: captionSideMargin(comp), y: margin };
      }
      const media = await buildMediaMap();
      const plan = await planCaptions(
        comp,
        {
          clipId,
          transcriptId: flags.transcript || undefined,
          maxWords,
          track: flags.track,
          style,
        },
        (id, transcriptId) => storedTranscriptForClip(comp, id, media, transcriptId),
      );
      const report = { captions: plan.captions, clipIds: plan.clipIds, track: plan.track };
      if (flags['dry-run'] || plan.ops.length === 0) {
        out({ ...report, applied: false, ...(flags['dry-run'] ? { dryRun: true } : {}) });
        return;
      }
      // The transcripts were read outside the write lock; reject if the doc moved since.
      const doc = await mutateComposition(plan.ops, { expectedBaseRev: comp.rev, timeline });
      out({ ...report, applied: true, rev: doc.rev });
      return;
    }

    case 'show': {
      const comp = await readComposition(timeline);
      const { exportable, blockers } = checkExportable(comp, await buildMediaMap(), getWorkspace());
      out({
        timeline,
        rev: comp.rev,
        durationSec: compositionDuration(comp),
        canvas: { width: comp.width, height: comp.height, fps: comp.fps, fit: comp.fit },
        loudness: comp.loudness,
        exportable,
        blockers,
        tracks: comp.tracks.map((t) => ({
          id: t.id,
          kind: t.kind,
          muted: t.muted,
          clips: t.clips.map((c) => {
            const framing = ownFraming(comp, c);
            return {
              id: c.id,
              kind: c.kind,
              startSec: c.startSec,
              endSec: clipEndSec(c),
              durationSec: clipDuration(c),
              label: clipLabel(c),
              ...(framing ? { framing } : {}),
            };
          }),
          transitions: t.transitions.map((tr) => ({
            afterClipId: tr.afterClipId,
            kind: tr.kind,
            durationSec: tr.durationSec,
          })),
        })),
      });
      return;
    }

    case 'at': {
      const [at] = positional;
      if (!at) throw new Error('Usage: clip timeline at <atSec>');
      const atSec = num(at, 0);
      const comp = await readComposition(timeline);
      out({
        atSec,
        clips: clipsAtTime(comp, atSec).map((h) => ({
          track: h.track.id,
          clipId: h.clip.id,
          kind: h.clip.kind,
          localOffsetSec: h.localOffsetSec,
          label: clipLabel(h.clip),
        })),
      });
      return;
    }

    case 'frame': {
      const [at, output] = positional;
      if (!at) throw new Error('Usage: clip timeline frame <atSec> [<output>]');
      const atSec = num(at, 0);
      const comp = await readComposition(timeline);
      const media = await buildMediaMap();
      const finalOutput = output ? resolveInput(output) : newOutputPath('timeline-frame', 'jpg');
      const plan = buildFrameAtPlan(
        comp,
        { media, dir: getWorkspace(), output: finalOutput },
        atSec,
      );
      const result = await runPlan(plan);
      out({ frame: result.output, atSec });
      return;
    }

    case 'undo': {
      const { undone, doc, label } = await undoLastDocOp(timeline);
      out(
        undone
          ? { undone: true, label, rev: doc.rev }
          : { undone: false, message: 'Nothing to undo.' },
      );
      return;
    }

    case 'redo': {
      const { redone, doc, label } = await redoDocOp(timeline);
      out(
        redone
          ? { redone: true, label, rev: doc.rev }
          : { redone: false, message: 'Nothing to redo.' },
      );
      return;
    }

    case 'log': {
      const log = await readDocOpLog(timeline);
      out({
        rev: log.rev,
        cursor: log.cursor,
        canUndo: log.cursor > 0,
        canRedo: log.cursor < log.entries.length,
        entries: log.entries.map((e, i) => ({
          id: e.id,
          label: e.label,
          state: i < log.cursor ? 'applied' : 'undone',
        })),
      });
      return;
    }

    case 'export': {
      if (flags.all === 'true') {
        const [dir] = positional;
        if (!dir) throw new Error('Usage: clip timeline export --all <dir>');
        if (flags.timeline !== undefined || (flags.format && flags.format !== 'mp4')) {
          throw new Error(
            '--all renders every short as mp4. Export one timeline with --timeline <id>, or a project with --format.',
          );
        }
        const shorts = (await listTimelines())
          .map((t) => t.id)
          .filter((id) => id !== MAIN_TIMELINE);
        if (shorts.length === 0) {
          throw new Error('No shorts to export. Make one with `clip timeline short`.');
        }
        const exported = await exportTimelines(shorts, resolveInput(dir));
        out({ exported });
        if (exported.some((e) => 'error' in e)) process.exitCode = 1;
        return;
      }
      const [output] = positional;
      const format = flags.format || (output && interchangeFormatFor(output)) || 'mp4';
      if (format !== 'mp4') {
        const parsed = InterchangeFormatSchema.safeParse(format);
        if (!parsed.success) {
          throw new Error(`--format must be mp4, fcpxml or xmeml, got "${format}".`);
        }
        const target = output
          ? resolveInput(output)
          : newOutputPath('timeline-export', interchangeExtension(parsed.data));
        const result = await exportInterchange(
          await readComposition(timeline),
          await buildMediaRefs(),
          {
            format: parsed.data,
            output: target,
          },
        );
        out({
          exported: target,
          format: result.format,
          files: result.files.map((f) => f.path),
          durationSec: result.durationSec,
          notes: result.notes,
        });
        return;
      }
      const comp = await readComposition(timeline);
      const media = await buildMediaMap();
      const finalOutput = output ? resolveInput(output) : newOutputPath('timeline-export', 'mp4');
      const plan = compileTimeline(comp, { media, dir: getWorkspace(), output: finalOutput });
      const result = await runPlan(plan);
      out({
        exported: result.output,
        steps: result.steps,
        durationSec: plan.durationSec,
        durationMs: result.durationMs,
        ...(result.loudness ? { loudness: result.loudness } : {}),
      });
      return;
    }

    default:
      throw new Error(`Unknown timeline command: ${sub}\n\n${TIMELINE_HELP}`);
  }
}
