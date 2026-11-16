import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildFrameAtPlan,
  CompileError,
  checkExportable,
  compileTimeline,
} from '../timeline/compile.js';
import type { Composition } from '../timeline/composition.js';
import {
  applyVerbs,
  listTimelines,
  NoTimelineError,
  readComposition,
  redoDocOp,
  undoLastDocOp,
} from '../timeline/document-store.js';
import {
  exportInterchange,
  InterchangeError,
  InterchangeFormatSchema,
  interchangeExtension,
} from '../timeline/interchange.js';
import { buildMediaMap } from '../timeline/media-registry.js';
import { reviewCuts } from '../timeline/review.js';
import { runPlan } from '../timeline/run-plan.js';
import { MAIN_TIMELINE, TimelineIdSchema } from '../timeline/schema.js';
import { ShortError } from '../timeline/shorts.js';
import { timelineOutline, transcribeClip } from '../timeline/transcript.js';
import { EditableVerbSchema } from '../timeline/verbs.js';
import { doctor } from '../tools/doctor.js';
import { WhisperLanguageSchema } from '../transcribe/whisper.js';
import {
  type CompositionSummary,
  confinedMediaMap,
  confinedMediaRefs,
  makeVerbContext,
  summarizeComposition,
} from '../ui/timeline-tools.js';
import {
  ensureWorkspace,
  getWorkspace,
  newOutputPath,
  resolveInWorkspace,
  WorkspaceBoundaryError,
} from '../workspace.js';

const MCP_NAME = 'makemyclip-editor';

/**
 * Read the package's own version, walking up from this module so it resolves both
 * from source (src/mcp/server.ts under vitest) and bundled (dist/cli.js at runtime)
 * — the depth to package.json differs between the two, so a fixed relative path
 * would break one of them.
 */
function resolvePackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@makemyclip/editor' && pkg.version) return pkg.version;
      } catch {
        // not our package.json (or unreadable) — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

const MCP_VERSION = resolvePackageVersion();

/** Wrap any JSON-able value as an MCP text result. */
function jsonResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** A JPEG on disk as MCP image content, so the client's model can look at it. */
async function jpegContent(
  path: string,
): Promise<{ type: 'image'; data: string; mimeType: 'image/jpeg' }> {
  return { type: 'image', data: (await readFile(path)).toString('base64'), mimeType: 'image/jpeg' };
}

/**
 * The document summary plus whether it can render — the SAME renderability signal
 * the CLI `timeline show` and the `clip ui` give, so the MCP agent isn't blind to
 * a gap/blocker until it tries to export.
 */
async function describeComposition(
  comp: Composition,
  timeline: string,
): Promise<CompositionSummary & { timeline: string; exportable: boolean; blockers: string[] }> {
  const media = await buildMediaMap();
  const { exportable, blockers } = checkExportable(comp, media, getWorkspace());
  return { timeline, ...summarizeComposition(comp), exportable, blockers };
}

/** Answer a missing timeline or a short that can't be made with `{ error }`:
 *  both are the agent's to fix, like an export it can't render. */
async function answeringTimelineErrors<T>(
  run: () => Promise<T>,
): Promise<T | ReturnType<typeof jsonResult>> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof NoTimelineError || err instanceof ShortError) {
      return jsonResult({ error: err.message });
    }
    throw err;
  }
}

const timelineInput = TimelineIdSchema.optional();

/**
 * Build the MakeMyClip Editor MCP server — a second front door onto the SAME
 * op-aware, undoable CompositionDoc the CLI, the `clip ui`, and the Claude Code
 * skill edit. Exposes the verb layer + introspection so an MCP client (Claude
 * Desktop, Cursor, …) can drive the editor with no API key. Media paths are
 * confined to the workspace via `makeVerbContext` (AGENTS.md non-negotiable #3).
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: MCP_NAME, version: MCP_VERSION });

  server.registerTool(
    'timeline_show',
    {
      title: 'Show the timeline',
      description:
        'Read a timeline document — tracks, clips, timings, and whether it can render (exportable + any blockers) — plus `timelines`, the ids of every timeline in the workspace (main and each short). Pass atSec to also get the rendered frame at that time as an image. Call this to ground yourself BEFORE editing and to VERIFY a change AFTER.',
      inputSchema: {
        timeline: timelineInput,
        atSec: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            'Also return the frame export would render at this timeline time, as an image.',
          ),
      },
    },
    async ({ timeline = MAIN_TIMELINE, atSec }) =>
      answeringTimelineErrors(async () => {
        const comp = await readComposition(timeline);
        const timelines = (await listTimelines()).map((t) => t.id);
        const summary = jsonResult({ ...(await describeComposition(comp, timeline)), timelines });
        if (atSec === undefined) return summary;
        const output = newOutputPath('mcp-frame', 'jpg');
        try {
          const plan = buildFrameAtPlan(
            comp,
            {
              media: await confinedMediaMap(comp),
              dir: getWorkspace(),
              output,
              tag: `mcp${randomBytes(4).toString('hex')}`,
            },
            atSec,
          );
          await runPlan(plan);
          return { content: [...summary.content, await jpegContent(output)] };
        } catch (err) {
          if (!(err instanceof CompileError)) throw err;
          const frameError = {
            type: 'text' as const,
            text: JSON.stringify({ frameError: err.message }),
          };
          return { content: [...summary.content, frameError] };
        } finally {
          await unlink(output).catch(() => undefined);
        }
      }),
  );

  server.registerTool(
    'timeline_check',
    {
      title: 'Check the cuts',
      description:
        "Review every hard cut (abutting clips with no transition). Reports cuts whose audio is loud right at the edge, which usually means a clipped word or a click, and returns a contact sheet image: one row per cut, the outgoing clip's last frame then the incoming clip's first. Run it after cutting (e.g. remove_silence) and before exporting.",
      inputSchema: { timeline: timelineInput },
    },
    async ({ timeline = MAIN_TIMELINE }) =>
      answeringTimelineErrors(async () => {
        const comp = await readComposition(timeline);
        const media = await confinedMediaMap(comp);
        const output = newOutputPath('cut-sheet', 'jpg');
        try {
          const { sheet, ...review } = await reviewCuts(comp, media, output, getWorkspace());
          const summary = jsonResult({
            ...review,
            sheet: sheet ? { cuts: sheet.cuts, truncated: sheet.truncated } : null,
          });
          return sheet ? { content: [...summary.content, await jpegContent(sheet.path)] } : summary;
        } finally {
          await unlink(output).catch(() => undefined);
        }
      }),
  );

  server.registerTool(
    'timeline_edit',
    {
      title: 'Edit the timeline',
      description:
        'Apply one or more editing verbs to the document as ONE undoable change. Verbs: add_media, add_text, add_color, trim, move, split, remove, remove_silence, cut_words, remove_retakes, caption_speech, reframe, set_framing, set_loudness, transition. remove_silence cuts the pauses out of a media clip (sensitivity 0–1, default 0.5) and moves later clips on its track up; it applies nothing when no pause is found. cut_words cuts words fromIndex..toIndex out of a clip, sending the transcriptId from the timeline_transcript call they came from; remove_retakes cuts the earlier take of each phrase said twice in a row. caption_speech turns stored transcripts into captions on a track above the video (short phrases, or one word at a time with maxWords 1), replacing captions already there; export burns them in. Captions do not move with later cuts, so caption after cutting, or run it again after a cut. On a portrait canvas they sit above the bottom quarter and stay narrow enough to keep clear of the Shorts, Reels and TikTok overlays (margin sets the distance from the edge), and their width follows the font size. reframe changes the output shape (aspect 9:16 for Shorts/Reels/TikTok, 1:1, 4:5, 16:9) and fills it (fit cover, the default, crops; contain shows bars); x/y (0 = left/top, 0.5 = center, 1 = right/bottom) pick the part of every current media clip that shows. set_framing sets the fit, zoom (scale 0.1–4) and position of one media clip. Check the result with timeline_show atSec. set_loudness sets the integrated loudness the mp4 export normalizes to (targetLufs -14 for YouTube/Shorts/Reels/TikTok, -16 for podcasts, null for off). ' +
        "make_short turns a long recording into a vertical short on a timeline of its own: send it with `timeline` set to a new id such as \"best-1\" (never main). It plays the given word ranges (read the source timeline's sentences with timeline_transcript and no clipId; the source defaults to main) with a little padding, cut from the source's clips so its silence and retake cuts carry in, on a 9:16 canvas filled edge to edge (x picks the part of the frame that shows), normalized to -14 LUFS, with captions. Pick whole sentences (15–60 s in all is typical); the result's warnings name a range that starts or ends mid-sentence. Look at a frame with timeline_show (same timeline, atSec), then adjust with reframe x. Undo on that timeline removes it; replace rebuilds it. Every other verb also takes `timeline`, so a short can be edited like main. " +
        'Batch related verbs into a single call. Media paths must be inside the workspace. Returns the updated document summary, including whether it can now render.',
      inputSchema: { timeline: timelineInput, verbs: z.array(EditableVerbSchema).min(1) },
    },
    async ({ timeline = MAIN_TIMELINE, verbs }) =>
      answeringTimelineErrors(async () => {
        const { doc, ops, warnings } = await applyVerbs(verbs, makeVerbContext(), timeline);
        return jsonResult({
          applied: ops.length,
          ...(warnings.length > 0 ? { warnings } : {}),
          document: await describeComposition(doc, timeline),
        });
      }),
  );

  server.registerTool(
    'timeline_transcript',
    {
      title: 'Transcribe the speech',
      description:
        "Transcribe the timeline's speech with the local whisper.cpp. Without clipId it returns the timeline as sentences: each with its timeline start and end, the clip it starts in, its word indices fromIndex..toIndex and its text, one page of about 40 KB at a time. Pass nextFromSec as fromSec for the next page, or fromSec/toSec for a stretch of the timeline. Read it to pick a short's moments, then send whole sentences' indices to make_short. " +
        "With clipId it returns that clip's words (view 'words'), each with its index and timeline time, plus phrases said twice in a row (retakes); view 'sentences' gives that clip's sentences instead. " +
        "transcriptIds (by source; with more than one source each sentence names its mediaId) and transcriptId identify the transcript: send one back with an edit by index so it is refused, not misplaced, if the source was transcribed again. A word's `index` is stable for its source file. Optional feature: if whisper.cpp or a model isn't set up, the error says how. The first call per source file takes a while; later calls reuse the stored transcript.",
      inputSchema: {
        timeline: timelineInput,
        clipId: z
          .string()
          .optional()
          .describe("Media clip to transcribe. Leave out for the whole timeline's sentences."),
        view: z
          .enum(['words', 'sentences'])
          .optional()
          .describe('words (default with a clipId) or sentences (default without one).'),
        fromSec: z
          .number()
          .nonnegative()
          .optional()
          .describe("Sentences starting at or after this timeline time (a page's nextFromSec)."),
        toSec: z
          .number()
          .positive()
          .optional()
          .describe('Sentences starting before this timeline time.'),
        language: WhisperLanguageSchema.optional(),
      },
    },
    async ({ timeline = MAIN_TIMELINE, clipId, view, fromSec, toSec, language }) =>
      answeringTimelineErrors(async () => {
        const comp = await readComposition(timeline);
        const media = await confinedMediaMap(comp);
        if ((view ?? (clipId ? 'words' : 'sentences')) === 'words') {
          if (!clipId) {
            return jsonResult({
              error: "The words view needs a clipId. Leave view out for the timeline's sentences.",
            });
          }
          return jsonResult(await transcribeClip(comp, clipId, media, { language }));
        }
        const outline = await timelineOutline(comp, media, { clipId, fromSec, toSec, language });
        // Compact, as the page size is counted: a long recording's outline is
        // what has to fit in one result.
        return { content: [{ type: 'text' as const, text: JSON.stringify(outline) }] };
      }),
  );

  server.registerTool(
    'timeline_undo',
    {
      title: 'Undo',
      description: 'Undo the most recent edit of a timeline (default main).',
      inputSchema: { timeline: timelineInput },
    },
    async ({ timeline = MAIN_TIMELINE }) =>
      answeringTimelineErrors(async () => {
        const { undone, label } = await undoLastDocOp(timeline);
        return jsonResult(undone ? { undone, label } : { undone, message: 'Nothing to undo.' });
      }),
  );

  server.registerTool(
    'timeline_redo',
    {
      title: 'Redo',
      description: 'Redo the most recently undone edit of a timeline (default main).',
      inputSchema: { timeline: timelineInput },
    },
    async ({ timeline = MAIN_TIMELINE }) =>
      answeringTimelineErrors(async () => {
        const { redone, label } = await redoDocOp(timeline);
        return jsonResult(redone ? { redone, label } : { redone, message: 'Nothing to redo.' });
      }),
  );

  server.registerTool(
    'timeline_export',
    {
      title: 'Export the timeline',
      description:
        'Export a timeline (default main; pass `timeline` for a short) to a file in the workspace and return its path. format mp4 (default) renders the video, normalized to the loudness set with set_loudness (the result reports the measured loudness). ' +
        'fcpxml writes an FCPXML project for Final Cut Pro and DaVinci Resolve; xmeml writes Final Cut Pro 7 XML for Premiere Pro (Resolve reads it too), with text as .srt caption files beside it. ' +
        'Both reference the source media by absolute path, refuse what the editor file cannot hold with the fix to make, and return notes on what is carried only in part.',
      inputSchema: {
        timeline: timelineInput,
        format: z
          .enum(['mp4', 'fcpxml', 'xmeml'])
          .optional()
          .describe(`Default mp4. ${InterchangeFormatSchema.description}`),
        output: z
          .string()
          .optional()
          .describe('Output file inside the workspace (relative paths resolve against it).'),
      },
    },
    async ({ timeline = MAIN_TIMELINE, format = 'mp4', output }) => {
      try {
        const comp = await readComposition(timeline);
        if (format !== 'mp4') {
          const target = output
            ? resolveInWorkspace(output)
            : newOutputPath('timeline-export', interchangeExtension(format));
          const result = await exportInterchange(comp, await confinedMediaRefs(comp), {
            format,
            output: target,
            confine: resolveInWorkspace,
          });
          return jsonResult({
            exported: target,
            format,
            files: result.files.map((f) => f.path),
            durationSec: result.durationSec,
            notes: result.notes,
          });
        }
        const media = await buildMediaMap();
        const target = output
          ? resolveInWorkspace(output)
          : newOutputPath('timeline-export', 'mp4');
        const plan = compileTimeline(comp, { media, dir: getWorkspace(), output: target });
        const result = await runPlan(plan);
        return jsonResult({
          exported: result.output,
          durationSec: plan.durationSec,
          ...(result.loudness ? { loudness: result.loudness } : {}),
        });
      } catch (err) {
        if (
          err instanceof CompileError ||
          err instanceof InterchangeError ||
          err instanceof WorkspaceBoundaryError ||
          err instanceof NoTimelineError
        ) {
          return jsonResult({ error: err.message });
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'doctor',
    {
      title: 'Check the setup',
      description:
        'Check that this computer has what the editor needs: Node, FFmpeg and its text and stabilization filters, a writable workspace and a caption font, plus the optional local whisper.cpp and model for transcription. Each problem comes with its fix, and howToSet says where the MAKEMYCLIP_* settings it names are changed. Run it when the user asks whether their setup works, or when a tool fails with a setup error.',
    },
    async () => jsonResult(await doctor()),
  );

  return server;
}

/**
 * Run the MCP server over stdio (how Claude Desktop and other local MCP clients
 * launch it). Nothing is written to stdout except the MCP protocol — stdout is
 * the transport channel.
 */
export async function runMcpServer(): Promise<void> {
  await ensureWorkspace();
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
