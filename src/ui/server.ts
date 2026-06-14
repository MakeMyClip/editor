import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { anthropic } from '@ai-sdk/anthropic';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';
import getPort from 'get-port';
import { Hono } from 'hono';
import open from 'open';
import { ZodError } from 'zod';
import { probe } from '../ffmpeg/probe.js';
import { appendOp, readSession, SessionCorruptError, snapshotsDir } from '../session/store.js';
import type { SessionEntry } from '../session/types.js';
import { ingest } from '../tools/ingest.js';
import { preview } from '../tools/preview.js';
import { snapshot } from '../tools/snapshot.js';
import { undo } from '../tools/undo.js';
import { ensureWorkspace, getWorkspace } from '../workspace.js';
import { buildChatTools } from './chat-tools.js';
import { isRegisteredTool, TOOL_REGISTRY } from './tool-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// `HERE` resolves to different paths depending on whether we're running
// the bundled `dist/cli.js` (everything is flattened so `HERE === dist/`)
// or the un-bundled `src/ui/server.ts` via tsx (HERE === src/ui/). The
// static UI is built by Vite into `dist/web/` in both cases.
const STATIC_DIR_CANDIDATES = [
  resolve(HERE, 'web'), // bundled cli.js — dist/web/ is alongside cli.js
  resolve(HERE, '../../dist/web'), // tsx src/ui/server.ts — two levels up
];

function findStaticDir(): string | null {
  for (const candidate of STATIC_DIR_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface UiServerOptions {
  /** Preferred port. Auto-picks a free port if this one is taken. */
  port?: number;
  /** If true, open the system browser after the server starts. */
  openBrowser?: boolean;
}

export interface UiServer {
  url: string;
  port: number;
  /** Stop the server (releases the port). */
  stop: () => Promise<void>;
}

/**
 * Resolve an op entry by id for the per-op routes, folding a corrupt session log
 * into a typed result instead of letting `readSession` throw a raw 500.
 */
async function resolveOpEntry(
  opId: string,
): Promise<
  | { kind: 'ok'; entry: SessionEntry }
  | { kind: 'corrupt'; error: SessionCorruptError }
  | { kind: 'notfound' }
> {
  try {
    const session = await readSession();
    const entry = session.entries.find((e) => e.id === opId);
    return entry ? { kind: 'ok', entry } : { kind: 'notfound' };
  } catch (err) {
    if (err instanceof SessionCorruptError) return { kind: 'corrupt', error: err };
    throw err;
  }
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const preferredPort = options.port ?? 5573;
  const port = await getPort({ port: [preferredPort, preferredPort + 1, preferredPort + 2] });

  const app = new Hono();

  // ─── API ────────────────────────────────────────────────────────────

  app.get('/api/workspace', async (c) => {
    return c.json({ path: getWorkspace() });
  });

  app.get('/api/session', async (c) => {
    try {
      const session = await readSession();
      return c.json(session);
    } catch (err) {
      // A corrupt session.json now surfaces (instead of silently resetting).
      // Translate it into an actionable 409 so the pane shows the path + how to
      // recover rather than a raw 500.
      if (err instanceof SessionCorruptError) {
        return c.json({ error: err.message, path: err.path, corrupt: true }, 409);
      }
      throw err;
    }
  });

  /**
   * List the tools the UI can dispatch via POST. Lets the frontend build
   * a picker without hardcoding the registry on its side.
   */
  app.get('/api/tools', (c) => {
    return c.json({ tools: Object.keys(TOOL_REGISTRY).sort() });
  });

  /**
   * Run a tool. Body is JSON matching the tool's Zod input schema.
   * Validates → calls → appends to session log → returns the result.
   * Zod errors become 400s with structured details; everything else 500.
   */
  app.post('/api/tools/:name', async (c) => {
    const name = c.req.param('name');
    if (!isRegisteredTool(name)) {
      return c.json({ error: `Unknown tool: ${name}` }, 404);
    }
    const entry = TOOL_REGISTRY[name];
    if (!entry) return c.json({ error: `Unknown tool: ${name}` }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }

    try {
      const validated = entry.schema.parse(body);
      const result = await entry.fn(validated);
      await appendOp({
        tool: name,
        args: body as Record<string, unknown>,
        result: result as Record<string, unknown>,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof ZodError) {
        return c.json({ error: 'Validation failed', issues: err.issues }, 400);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  /**
   * Session safety endpoints. These intentionally live outside the
   * /api/tools/:name registry because snapshot/undo are meta-operations on
   * the session log itself — they shouldn't appear as ops *in* the log.
   */

  /** POST /api/session/snapshot — body: { label?: string }. */
  app.post('/api/session/snapshot', async (c) => {
    let body: { label?: unknown };
    try {
      body = (await c.req.json()) as { label?: unknown };
    } catch {
      body = {};
    }
    const label = typeof body.label === 'string' && body.label.length > 0 ? body.label : undefined;
    try {
      const result = await snapshot({ label });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  /**
   * POST /api/session/undo — body: { snapshotLabel?: string }. Pops the
   * last op when label is absent, or restores the named snapshot otherwise.
   */
  app.post('/api/session/undo', async (c) => {
    let body: { snapshotLabel?: unknown };
    try {
      body = (await c.req.json()) as { snapshotLabel?: unknown };
    } catch {
      body = {};
    }
    const snapshotLabel =
      typeof body.snapshotLabel === 'string' && body.snapshotLabel.length > 0
        ? body.snapshotLabel
        : undefined;
    try {
      const result = await undo({ snapshotLabel });
      return c.json(result);
    } catch (err) {
      // A corrupt snapshot is a recoverable bad-input condition, not a server
      // fault — surface it as a 409 with the path, like the other read paths.
      if (err instanceof SessionCorruptError) {
        return c.json({ error: err.message, path: err.path, corrupt: true }, 409);
      }
      const message = err instanceof Error ? err.message : String(err);
      // "nothing to undo" / "snapshot not found" → 400, server faults → 500.
      const status = /empty|nothing|not found/i.test(message) ? 400 : 500;
      return c.json({ error: message }, status);
    }
  });

  /**
   * GET /api/session/snapshots — list of available labels. We just read the
   * filenames; reading each file to count entries would be wasted I/O for
   * the header dropdown's purposes.
   */
  app.get('/api/session/snapshots', async (c) => {
    const dir = snapshotsDir();
    if (!existsSync(dir)) return c.json({ snapshots: [] });
    const files = await readdir(dir);
    const labels = files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    return c.json({ snapshots: labels });
  });

  // ─── Chat (Anthropic via AI SDK) ───────────────────────────────────

  /**
   * Path to the persisted chat history. We store one file per workspace so
   * a project's chat moves with its session.json.
   */
  function chatPath(): string {
    return resolve(getWorkspace(), 'chat.json');
  }

  async function readChatHistory(): Promise<UIMessage[]> {
    try {
      const raw = await readFile(chatPath(), 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as UIMessage[];
      return [];
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return [];
      // Corrupt history → start fresh; better than blocking chat outright.
      return [];
    }
  }

  async function writeChatHistory(messages: UIMessage[]): Promise<void> {
    await ensureWorkspace();
    await writeFile(chatPath(), `${JSON.stringify(messages, null, 2)}\n`);
  }

  function summarizeEntryForChat(e: {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }): string {
    const path =
      typeof e.result.path === 'string'
        ? e.result.path
        : typeof (e.result.ref as { path?: unknown })?.path === 'string'
          ? (e.result.ref as { path: string }).path
          : '(no playable path)';
    return `- ${e.id} ${e.tool} → ${path}`;
  }

  function buildSystemPrompt(): Promise<string> {
    return readSession().then((session) => {
      const workspace = getWorkspace();
      const recent = session.entries.slice(-20).map(summarizeEntryForChat).join('\n');
      const head =
        session.entries.length > 20
          ? `\n(showing last 20 of ${session.entries.length}; older ops exist)\n`
          : '';
      return [
        'You are the assistant inside MakeMyClip Editor — an FFmpeg-backed video editor.',
        'You run editing operations by calling tools. Each tool call produces a new output file and appends one entry to the session log; the UI picks it up automatically.',
        '',
        'Conventions:',
        '- Refer to media by absolute file paths only — never relative.',
        "- Chain ops by passing the previous op result's `path` as the next op's `input` (or `result.ref.path` for ingest).",
        '- Prefer stream-copy ops (trim, split, concat) before re-encoding ops (transition, add_text, render) to keep results fast and lossless.',
        '- When the user asks for something ambiguous, call `inspect`-style tools or read the session list to ground yourself before editing.',
        '',
        `Workspace: ${workspace}`,
        `Session has ${session.entries.length} entries.${head}`,
        recent ? `Recent ops:\n${recent}` : 'Session is empty.',
      ].join('\n');
    });
  }

  /**
   * GET /api/chat — persisted history (UIMessage[]). Returns empty array
   * for a fresh workspace.
   */
  app.get('/api/chat', async (c) => {
    const messages = await readChatHistory();
    return c.json({ messages });
  });

  /**
   * DELETE /api/chat — clear history.
   */
  app.delete('/api/chat', async (c) => {
    await writeChatHistory([]);
    return c.json({ messages: [] });
  });

  /**
   * POST /api/chat — `useChat` transport target. Body is `{ messages:
   * UIMessage[] }`. Returns a UI message stream the @ai-sdk/react hook
   * consumes. Each agent turn can fire several tool calls (multi-step)
   * up to `stopWhen` — tools mutate session.json, the UI's session poll
   * picks them up.
   */
  app.post('/api/chat', async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return c.json(
        {
          error: 'ANTHROPIC_API_KEY is not set. Add it to your environment and restart `clip ui`.',
        },
        400,
      );
    }
    let body: { messages?: UIMessage[] };
    try {
      body = (await c.req.json()) as { messages?: UIMessage[] };
    } catch {
      return c.json({ error: 'Body must be JSON with a `messages` array.' }, 400);
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];

    let system: string;
    try {
      // buildSystemPrompt reads the session; a corrupt file used to brick every
      // chat turn with a raw 500. Degrade to an actionable message instead.
      system = await buildSystemPrompt();
    } catch (err) {
      if (err instanceof SessionCorruptError) {
        return c.json(
          {
            error: `Session file is corrupt: ${err.path}. Recover with \`clip undo <snapshotLabel>\` or remove it, then retry.`,
          },
          409,
        );
      }
      throw err;
    }
    const modelMessages = await convertToModelMessages(messages);
    const result = streamText({
      // Sonnet 4.6 is the sweet spot for tool-use latency / cost; the user
      // can swap models later via env / a settings panel.
      model: anthropic('claude-sonnet-4-6'),
      system,
      messages: modelMessages,
      tools: buildChatTools(),
      // Up to 8 chained tool calls per turn — enough for "trim three clips
      // then concat" without runaway loops.
      stopWhen: stepCountIs(8),
    });

    return result.toUIMessageStreamResponse({
      // Persist the full updated conversation when the stream finishes so
      // a page reload restores the chat.
      onFinish: async ({ messages: finalMessages }) => {
        try {
          await writeChatHistory(finalMessages);
        } catch (err) {
          // Don't block the response on persistence — log it server-side.
          console.warn('Could not persist chat history:', err);
        }
      },
    });
  });

  // ─── Duration probe (Timeline scrub slider) ───────────────────────

  // In-memory cache: session entries are append-only and clip files don't
  // change, so a duration we measured once stays valid for the lifetime
  // of the server.
  const durationCache = new Map<string, number>();

  /**
   * GET /api/duration/:opId — { durationSec } for the op's playable file.
   * Used by the Timeline scrub slider so each card knows its range.
   */
  app.get('/api/duration/:opId', async (c) => {
    const opId = c.req.param('opId');
    const cached = durationCache.get(opId);
    if (cached !== undefined) return c.json({ durationSec: cached });

    const resolved = await resolveOpEntry(opId);
    if (resolved.kind === 'corrupt') {
      return c.json(
        { error: resolved.error.message, path: resolved.error.path, corrupt: true },
        409,
      );
    }
    if (resolved.kind === 'notfound') return c.json({ error: `No op ${opId}` }, 404);
    const entry = resolved.entry;

    const path = playablePathOf(entry);
    if (!path || !existsSync(path)) {
      return c.json({ error: `No playable path for op ${opId}` }, 404);
    }
    try {
      const probed = await probe(path);
      durationCache.set(opId, probed.durationSec);
      return c.json({ durationSec: probed.durationSec });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  /**
   * Drag-drop / Browse upload. Streams each file into `<workspace>/imports/`
   * under a uniquified name, runs `ingest` to probe + register it, and
   * appends one session entry per file — mirroring exactly what
   * `clip ingest <path>` does. Returns the new entries so the UI can refresh
   * without waiting for the next poll.
   *
   * Filename safety: we take only `basename(file.name)` (no traversal),
   * replace any remaining separators with underscores, and prefix with 4
   * random hex bytes so concurrent uploads of the same name don't collide.
   */
  app.post('/api/import', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody({ all: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Could not parse upload: ${message}` }, 400);
    }

    // Accept either repeated `files` (preferred) or a single `file` key.
    const raw = body.files ?? body.file;
    const files: File[] = (Array.isArray(raw) ? raw : [raw]).filter(
      (f): f is File => f instanceof File,
    );
    if (files.length === 0) {
      return c.json(
        { error: 'No files in upload — expected multipart field "files" or "file".' },
        400,
      );
    }

    const workspace = await ensureWorkspace();
    const importsDir = resolve(workspace, 'imports');
    await mkdir(importsDir, { recursive: true });

    const imported: Array<{ entry: unknown; originalName: string; path: string }> = [];
    try {
      for (const file of files) {
        const safeBase = basename(file.name).replace(/[/\\]/g, '_') || 'upload';
        const id = randomBytes(4).toString('hex');
        const destPath = resolve(importsDir, `${id}-${safeBase}`);

        // Stream the upload to disk so multi-GB screen recordings don't sit
        // in memory. `Readable.fromWeb` adapts the web ReadableStream that
        // File.stream() returns into a Node stream `pipeline` can drive.
        const nodeStream = Readable.fromWeb(
          file.stream() as Parameters<typeof Readable.fromWeb>[0],
        );
        await pipeline(nodeStream, createWriteStream(destPath));

        const result = await ingest({ path: destPath });
        const entry = await appendOp({
          tool: 'ingest',
          args: { path: destPath },
          result: result as unknown as Record<string, unknown>,
        });
        imported.push({ entry, originalName: file.name, path: destPath });
      }
      return c.json({ imported });
    } catch (err) {
      // Partial-success is possible — earlier files are already on disk and
      // logged. Surface the failing filename so the user knows where it broke.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, imported }, 500);
    }
  });

  /**
   * Pull the on-disk path out of an op result, accounting for the different
   * shapes each tool produces. Ingest hides its file under `result.ref.path`;
   * split has two halves (we play the first); most others use `result.path`.
   */
  function playablePathOf(entry: { tool: string; result: Record<string, unknown> }): string | null {
    if (entry.tool === 'ingest') {
      const ref = entry.result.ref as { path?: unknown } | undefined;
      return typeof ref?.path === 'string' ? ref.path : null;
    }
    if (typeof entry.result.path === 'string') return entry.result.path;
    if (typeof entry.result.before === 'string') return entry.result.before;
    return null;
  }

  /**
   * Stream the output file recorded under an op. We resolve the path from
   * `session.json` rather than accepting it from the client so the server
   * never serves files outside the workspace, even though it's localhost-only.
   */
  app.get('/api/output/:opId', async (c) => {
    const opId = c.req.param('opId');
    const resolved = await resolveOpEntry(opId);
    if (resolved.kind === 'corrupt') return c.text(resolved.error.message, 409);
    if (resolved.kind === 'notfound') return c.text(`No op ${opId}`, 404);
    const entry = resolved.entry;

    const path = playablePathOf(entry);
    if (!path) return c.text(`Op ${opId} has no playable output`, 404);
    if (!existsSync(path)) return c.text(`Output file missing: ${path}`, 410);

    const { size } = await stat(path);
    const ext = path.split('.').pop()?.toLowerCase() ?? 'bin';
    const mime =
      ext === 'mp4' || ext === 'mov'
        ? 'video/mp4'
        : ext === 'webm'
          ? 'video/webm'
          : ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : ext === 'png'
              ? 'image/png'
              : 'application/octet-stream';

    // Hono on Node can stream via a ReadableStream from a file. For v0.1
    // we use Node's createReadStream wrapped in a web stream.
    const { createReadStream } = await import('node:fs');
    const nodeStream = createReadStream(path);
    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on('data', (chunk) => controller.enqueue(chunk as Uint8Array));
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', (err) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });

    return new Response(webStream, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(size),
      },
    });
  });

  /**
   * Generate a preview thumbnail for an op's output and return the JPEG.
   * We re-call our `preview` tool — it's already idempotent for the same
   * input + timecode, and the JPEG lives in the workspace afterward.
   */
  app.get('/api/preview/:opId', async (c) => {
    const opId = c.req.param('opId');
    const atSec = Number(c.req.query('atSec') ?? '0');

    const resolved = await resolveOpEntry(opId);
    if (resolved.kind === 'corrupt') return c.text(resolved.error.message, 409);
    if (resolved.kind === 'notfound') return c.text(`No op ${opId}`, 404);
    const entry = resolved.entry;

    const path = playablePathOf(entry);
    if (!path || !existsSync(path)) return c.text(`No preview-able output for op ${opId}`, 404);

    const { path: jpegPath } = await preview({ input: path, atSec });
    const { createReadStream } = await import('node:fs');
    const { size } = await stat(jpegPath);
    const nodeStream = createReadStream(jpegPath);
    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on('data', (chunk) => controller.enqueue(chunk as Uint8Array));
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', (err) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });
    return new Response(webStream, {
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(size) },
    });
  });

  // ─── Static (built React app) ──────────────────────────────────────

  const staticDir = findStaticDir();
  if (staticDir) {
    app.use(
      '*',
      serveStatic({
        root: staticDir,
        // Hono's serveStatic expects a relative root; we pass absolute via path resolver.
        rewriteRequestPath: (path) => path,
      }),
    );
    // SPA fallback: any non-asset path should serve index.html so React Router (if added later) works.
    app.get('*', async (c) => {
      const { readFile } = await import('node:fs/promises');
      try {
        const html = await readFile(resolve(staticDir, 'index.html'), 'utf-8');
        return c.html(html);
      } catch {
        return c.text('UI assets not built. Run `pnpm build` first.', 500);
      }
    });
  } else {
    app.get('*', (c) =>
      c.text(
        'UI assets not found. Run `pnpm build` in the editor package (or `pnpm dev:ui` for dev).',
        500,
      ),
    );
  }

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  const url = `http://127.0.0.1:${port}`;

  if (options.openBrowser !== false) {
    // Don't block server startup on browser-open failures (e.g. headless env).
    open(url).catch(() => undefined);
  }

  return {
    url,
    port,
    stop: () =>
      new Promise<void>((resolveStop) => {
        server.close(() => resolveStop());
      }),
  };
}
