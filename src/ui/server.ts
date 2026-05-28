import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import getPort from 'get-port';
import { Hono } from 'hono';
import open from 'open';
import { ZodError } from 'zod';
import { appendOp, readSession } from '../session/store.js';
import { preview } from '../tools/preview.js';
import { getWorkspace } from '../workspace.js';
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

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const preferredPort = options.port ?? 5573;
  const port = await getPort({ port: [preferredPort, preferredPort + 1, preferredPort + 2] });

  const app = new Hono();

  // ─── API ────────────────────────────────────────────────────────────

  app.get('/api/workspace', async (c) => {
    return c.json({ path: getWorkspace() });
  });

  app.get('/api/session', async (c) => {
    const session = await readSession();
    return c.json(session);
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
   * Stream the output file recorded under an op. We resolve the path from
   * `session.json` rather than accepting it from the client so the server
   * never serves files outside the workspace, even though it's localhost-only.
   */
  app.get('/api/output/:opId', async (c) => {
    const opId = c.req.param('opId');
    const session = await readSession();
    const entry = session.entries.find((e) => e.id === opId);
    if (!entry) return c.text(`No op ${opId}`, 404);

    const path =
      typeof entry.result.path === 'string'
        ? entry.result.path
        : typeof entry.result.before === 'string'
          ? entry.result.before
          : null;
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

    const session = await readSession();
    const entry = session.entries.find((e) => e.id === opId);
    if (!entry) return c.text(`No op ${opId}`, 404);

    const path =
      typeof entry.result.path === 'string'
        ? entry.result.path
        : typeof entry.result.before === 'string'
          ? entry.result.before
          : null;
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
