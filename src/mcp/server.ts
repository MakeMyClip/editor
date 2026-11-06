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
  readComposition,
  redoDocOp,
  undoLastDocOp,
} from '../timeline/document-store.js';
import { buildMediaMap } from '../timeline/media-registry.js';
import { reviewCuts } from '../timeline/review.js';
import { runPlan } from '../timeline/run-plan.js';
import { transcribeClip } from '../timeline/transcript.js';
import { EditableVerbSchema } from '../timeline/verbs.js';
import { WhisperLanguageSchema } from '../transcribe/whisper.js';
import {
  type CompositionSummary,
  confinedMediaMap,
  makeVerbContext,
  summarizeComposition,
} from '../ui/timeline-tools.js';
import { ensureWorkspace, getWorkspace, newOutputPath } from '../workspace.js';

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
): Promise<CompositionSummary & { exportable: boolean; blockers: string[] }> {
  const media = await buildMediaMap();
  const { exportable, blockers } = checkExportable(comp, media, getWorkspace());
  return { ...summarizeComposition(comp), exportable, blockers };
}

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
        'Read the current timeline document — tracks, clips, timings, and whether it can render (exportable + any blockers). Pass atSec to also get the rendered frame at that time as an image. Call this to ground yourself BEFORE editing and to VERIFY a change AFTER.',
      inputSchema: {
        atSec: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            'Also return the frame export would render at this timeline time, as an image.',
          ),
      },
    },
    async ({ atSec }) => {
      const comp = await readComposition();
      const summary = jsonResult(await describeComposition(comp));
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
    },
  );

  server.registerTool(
    'timeline_check',
    {
      title: 'Check the cuts',
      description:
        "Review every hard cut (abutting clips with no transition). Reports cuts whose audio is loud right at the edge, which usually means a clipped word or a click, and returns a contact sheet image: one row per cut, the outgoing clip's last frame then the incoming clip's first. Run it after cutting (e.g. remove_silence) and before exporting.",
    },
    async () => {
      const comp = await readComposition();
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
    },
  );

  server.registerTool(
    'timeline_edit',
    {
      title: 'Edit the timeline',
      description:
        'Apply one or more editing verbs to the document as ONE undoable change. Verbs: add_media, add_text, add_color, trim, move, split, remove, remove_silence, transition. remove_silence cuts the pauses out of a media clip (sensitivity 0–1, default 0.5) and moves later clips on its track up; it applies nothing when no pause is found. Batch related verbs into a single call. Media paths must be inside the workspace. Returns the updated document summary, including whether it can now render.',
      inputSchema: { verbs: z.array(EditableVerbSchema).min(1) },
    },
    async ({ verbs }) => {
      const { doc, ops } = await applyVerbs(verbs, makeVerbContext());
      return jsonResult({ applied: ops.length, document: await describeComposition(doc) });
    },
  );

  server.registerTool(
    'timeline_transcript',
    {
      title: 'Transcribe a clip',
      description:
        "Transcribe a media clip's speech with the local whisper.cpp and return its words with timeline times. Optional feature: if whisper.cpp or a model isn't set up, the error says how. The first call per source file takes a while; later calls reuse the stored transcript. A word's `index` is stable for its source file.",
      inputSchema: {
        clipId: z.string().describe('Media clip to transcribe.'),
        language: WhisperLanguageSchema.optional(),
      },
    },
    async ({ clipId, language }) => {
      const comp = await readComposition();
      return jsonResult(
        await transcribeClip(comp, clipId, await confinedMediaMap(comp), { language }),
      );
    },
  );

  server.registerTool(
    'timeline_undo',
    { title: 'Undo', description: 'Undo the most recent timeline edit.' },
    async () => {
      const { undone, label } = await undoLastDocOp();
      return jsonResult(undone ? { undone, label } : { undone, message: 'Nothing to undo.' });
    },
  );

  server.registerTool(
    'timeline_redo',
    { title: 'Redo', description: 'Redo the most recently undone timeline edit.' },
    async () => {
      const { redone, label } = await redoDocOp();
      return jsonResult(redone ? { redone, label } : { redone, message: 'Nothing to redo.' });
    },
  );

  server.registerTool(
    'timeline_export',
    {
      title: 'Export the timeline',
      description:
        'Render the current timeline document to an mp4 file in the workspace and return its path.',
    },
    async () => {
      const comp = await readComposition();
      const media = await buildMediaMap();
      const output = newOutputPath('timeline-export', 'mp4');
      try {
        const plan = compileTimeline(comp, { media, dir: getWorkspace(), output });
        const result = await runPlan(plan);
        return jsonResult({ exported: result.output, durationSec: plan.durationSec });
      } catch (err) {
        if (err instanceof CompileError) return jsonResult({ error: err.message });
        throw err;
      }
    },
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
