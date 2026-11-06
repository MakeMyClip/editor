import { appendOp } from './session/store.js';
import { CaptionError, DEFAULT_CAPTION_WORDS, planCaptions } from './timeline/captions.js';
import { buildFrameAtPlan, checkExportable, compileTimeline } from './timeline/compile.js';
import {
  AnchorSchema,
  type Clip,
  clipDuration,
  clipEndSec,
  clipsAtTime,
  compositionDuration,
  emptyComposition,
  makeClipId,
  type TextStyle,
} from './timeline/composition.js';
import {
  mutateComposition,
  readComposition,
  readDocOpLog,
  redoDocOp,
  resetComposition,
  undoLastDocOp,
} from './timeline/document-store.js';
import { buildMediaMap } from './timeline/media-registry.js';
import { colorClip, mediaClip, textClip } from './timeline/ops.js';
import { reviewCuts } from './timeline/review.js';
import { runPlan } from './timeline/run-plan.js';
import { analyzeSilence, DEFAULT_SENSITIVITY, SensitivitySchema } from './timeline/silence.js';
import {
  clipWords,
  findRetakes,
  planWordCut,
  storedTranscriptForClip,
  transcribeClip,
} from './timeline/transcript.js';
import { DEFAULT_VERB_TRACK as DEFAULT_TRACK, ensureTrack, trackEnd } from './timeline/verbs.js';
import { ingest } from './tools/ingest.js';
import { getWorkspace, newOutputPath, resolveInput } from './workspace.js';

const TIMELINE_HELP = `clip timeline — build and export a non-destructive composition

  clip timeline new [--width W --height H --fps F --background C]
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
  clip timeline transcribe <clipId> [--model <model.bin>] [--language <code>]
  clip timeline cut-words <clipId> <fromIndex> <toIndex> [--transcript <id>]
  clip timeline remove-retakes <clipId> [--dry-run] [--transcript <id>]
  clip timeline captions [<clipId>] [--words N] [--track T] [--font N --color C --anchor A --background C|none] [--dry-run]
  clip timeline show
  clip timeline at <atSec>
  clip timeline frame <atSec> [<output>]
  clip timeline undo
  clip timeline redo
  clip timeline log
  clip timeline export [<output>]
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string>;
}

/** Flags that take no value, so they don't swallow the next argument. */
const BOOLEAN_FLAGS = new Set(['dry-run']);

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
  const [sub, ...rest] = args;
  const { positional, flags } = parseArgs(rest);

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
          background: flags.background,
        }),
      );
      out({ created: true, width: comp.width, height: comp.height, fps: comp.fps });
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
      const comp = await readComposition();
      const start = flags.start !== undefined ? num(flags.start, 0) : trackEnd(comp, trackId);
      const clip = mediaClip({
        id: makeClipId(),
        mediaId: result.mediaId,
        sourceInSec: num(inSec, 0),
        sourceOutSec: num(outSec, result.ref.durationSec),
        startSec: start,
      });
      await mutateComposition([...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }]);
      out({ added: 'media', clipId: clip.id, mediaId: result.mediaId, trackId, startSec: start });
      return;
    }

    case 'add-text': {
      const [text, duration] = positional;
      if (!text || duration === undefined) {
        throw new Error('Usage: clip timeline add-text <text> <durationSec>');
      }
      const trackId = flags.track || DEFAULT_TRACK;
      const comp = await readComposition();
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
      await mutateComposition([...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }]);
      out({ added: 'text', clipId: clip.id, trackId, startSec: start });
      return;
    }

    case 'add-color': {
      const [duration] = positional;
      if (duration === undefined) throw new Error('Usage: clip timeline add-color <durationSec>');
      const trackId = flags.track || DEFAULT_TRACK;
      const comp = await readComposition();
      const start = flags.start !== undefined ? num(flags.start, 0) : trackEnd(comp, trackId);
      const clip = colorClip({
        id: makeClipId(),
        color: flags.color,
        durationSec: num(duration, 2),
        startSec: start,
      });
      await mutateComposition([...ensureTrack(comp, trackId), { op: 'addClip', trackId, clip }]);
      out({ added: 'color', clipId: clip.id, trackId, startSec: start });
      return;
    }

    case 'transition': {
      const [afterClipId, kind, duration] = positional;
      if (!afterClipId)
        throw new Error('Usage: clip timeline transition <afterClipId> [<kind>] [<durationSec>]');
      const trackId = flags.track || DEFAULT_TRACK;
      await mutateComposition([
        {
          op: 'addTransition',
          trackId,
          transition: {
            afterClipId,
            kind: (kind as never) ?? 'fade',
            durationSec: num(duration, 1),
          },
        },
      ]);
      out({ added: 'transition', afterClipId, kind: kind ?? 'fade', trackId });
      return;
    }

    case 'trim': {
      const [clipId, inSec, outSec] = positional;
      if (!clipId || inSec === undefined || outSec === undefined) {
        throw new Error('Usage: clip timeline trim <clipId> <inSec> <outSec>');
      }
      await mutateComposition([
        { op: 'setTrim', clipId, sourceInSec: num(inSec, 0), sourceOutSec: num(outSec, 0) },
      ]);
      out({ trimmed: clipId, sourceInSec: num(inSec, 0), sourceOutSec: num(outSec, 0) });
      return;
    }

    case 'move': {
      const [clipId, startSec] = positional;
      if (!clipId || startSec === undefined)
        throw new Error('Usage: clip timeline move <clipId> <startSec>');
      await mutateComposition([
        { op: 'moveClip', clipId, startSec: num(startSec, 0), toTrackId: flags.track || undefined },
      ]);
      out({ moved: clipId, startSec: num(startSec, 0), trackId: flags.track || undefined });
      return;
    }

    case 'split': {
      const [clipId, atSec] = positional;
      if (!clipId || atSec === undefined)
        throw new Error('Usage: clip timeline split <clipId> <atSec>');
      const newClipId = makeClipId();
      await mutateComposition([{ op: 'splitClip', clipId, atSec: num(atSec, 0), newClipId }]);
      out({ split: clipId, into: [clipId, newClipId], atSec: num(atSec, 0) });
      return;
    }

    case 'remove': {
      const [clipId] = positional;
      if (!clipId) throw new Error('Usage: clip timeline remove <clipId>');
      await mutateComposition([{ op: 'removeClip', clipId }]);
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
      const comp = await readComposition();
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
      const doc = await mutateComposition([cut.op], { expectedBaseRev: comp.rev });
      out({ ...report, applied: true, clipIds: [clipId, ...cut.op.newClipIds], rev: doc.rev });
      return;
    }

    case 'check': {
      const comp = await readComposition();
      const media = await buildMediaMap();
      const sheetPath = flags.sheet ? resolveInput(flags.sheet) : newOutputPath('cut-sheet', 'jpg');
      out(await reviewCuts(comp, media, sheetPath, getWorkspace()));
      return;
    }

    case 'transcribe': {
      const [clipId] = positional;
      if (!clipId) {
        throw new Error(
          'Usage: clip timeline transcribe <clipId> [--model <model.bin>] [--language <code>]',
        );
      }
      const comp = await readComposition();
      out(
        await transcribeClip(comp, clipId, await buildMediaMap(), {
          model: flags.model ? resolveInput(flags.model) : undefined,
          language: flags.language || undefined,
        }),
      );
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
      const comp = await readComposition();
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
      const doc = await mutateComposition([op], { expectedBaseRev: comp.rev });
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
      const comp = await readComposition();
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
      const doc = await mutateComposition(plan.ops, { expectedBaseRev: comp.rev });
      out({ ...report, applied: true, rev: doc.rev });
      return;
    }

    case 'show': {
      const comp = await readComposition();
      const { exportable, blockers } = checkExportable(comp, await buildMediaMap(), getWorkspace());
      out({
        rev: comp.rev,
        durationSec: compositionDuration(comp),
        canvas: { width: comp.width, height: comp.height, fps: comp.fps },
        exportable,
        blockers,
        tracks: comp.tracks.map((t) => ({
          id: t.id,
          kind: t.kind,
          muted: t.muted,
          clips: t.clips.map((c) => ({
            id: c.id,
            kind: c.kind,
            startSec: c.startSec,
            endSec: clipEndSec(c),
            durationSec: clipDuration(c),
            label: clipLabel(c),
          })),
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
      const comp = await readComposition();
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
      const comp = await readComposition();
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
      const { undone, doc, label } = await undoLastDocOp();
      out(
        undone
          ? { undone: true, label, rev: doc.rev }
          : { undone: false, message: 'Nothing to undo.' },
      );
      return;
    }

    case 'redo': {
      const { redone, doc, label } = await redoDocOp();
      out(
        redone
          ? { redone: true, label, rev: doc.rev }
          : { redone: false, message: 'Nothing to redo.' },
      );
      return;
    }

    case 'log': {
      const log = await readDocOpLog();
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
      const [output] = positional;
      const comp = await readComposition();
      const media = await buildMediaMap();
      const finalOutput = output ? resolveInput(output) : newOutputPath('timeline-export', 'mp4');
      const plan = compileTimeline(comp, { media, dir: getWorkspace(), output: finalOutput });
      const result = await runPlan(plan);
      out({
        exported: result.output,
        steps: result.steps,
        durationSec: plan.durationSec,
        durationMs: result.durationMs,
      });
      return;
    }

    default:
      throw new Error(`Unknown timeline command: ${sub}\n\n${TIMELINE_HELP}`);
  }
}
