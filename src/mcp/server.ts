import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CompileError, checkExportable, compileTimeline } from '../timeline/compile.js';
import type { Composition } from '../timeline/composition.js';
import {
  applyVerbs,
  readComposition,
  redoDocOp,
  undoLastDocOp,
} from '../timeline/document-store.js';
import { buildMediaMap } from '../timeline/media-registry.js';
import { runPlan } from '../timeline/run-plan.js';
import { EditableVerbSchema } from '../timeline/verbs.js';
import {
  type CompositionSummary,
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
        'Read the current timeline document — tracks, clips, timings, and whether it can render (exportable + any blockers). Call this to ground yourself BEFORE editing and to VERIFY a change AFTER.',
    },
    async () => jsonResult(await describeComposition(await readComposition())),
  );

  server.registerTool(
    'timeline_edit',
    {
      title: 'Edit the timeline',
      description:
        'Apply one or more editing verbs to the document as ONE undoable change. Verbs: add_media, add_text, add_color, trim, move, split, remove, transition. Batch related verbs into a single call. Media paths must be inside the workspace. Returns the updated document summary, including whether it can now render.',
      inputSchema: { verbs: z.array(EditableVerbSchema).min(1) },
    },
    async ({ verbs }) => {
      const { doc, ops } = await applyVerbs(verbs, makeVerbContext());
      return jsonResult({ applied: ops.length, document: await describeComposition(doc) });
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
