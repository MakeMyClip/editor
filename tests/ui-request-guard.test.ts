import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startUiServer, type UiServer } from '../src/ui/server.js';

interface Reply {
  status: number;
  body: string;
}

// node:http rather than fetch: the tests need to set Host and Origin, which
// fetch treats as forbidden request headers.
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () => resolveReply({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let server: UiServer;
let workspace: string;
let savedWorkspace: string | undefined;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-ui-guard-test-'));
  savedWorkspace = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
  server = await startUiServer({ openBrowser: false });
});

afterAll(async () => {
  await server.stop();
  if (savedWorkspace === undefined) {
    delete process.env.MAKEMYCLIP_WORKSPACE;
  } else {
    process.env.MAKEMYCLIP_WORKSPACE = savedWorkspace;
  }
  await rm(workspace, { recursive: true, force: true });
});

describe('clip ui request guard', () => {
  it('serves a same-origin write from the UI', async () => {
    const host = `127.0.0.1:${server.port}`;
    const reply = await send(
      server.port,
      'POST',
      '/api/session/snapshot',
      { host, origin: `http://${host}`, 'content-type': 'text/plain;charset=UTF-8' },
      '{}',
    );
    expect(reply.status).toBe(200);
  });

  it('serves a write through the Vite dev proxy, which keeps the browser Host', async () => {
    const reply = await send(
      server.port,
      'POST',
      '/api/session/snapshot',
      {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      '{}',
    );
    expect(reply.status).toBe(200);
  });

  it('serves a JSON write from a non-browser client that sends no Origin', async () => {
    const reply = await send(
      server.port,
      'POST',
      '/api/session/snapshot',
      { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json' },
      '{}',
    );
    expect(reply.status).toBe(200);
  });

  it('rejects a cross-site text/plain write (no CORS preflight)', async () => {
    const reply = await send(
      server.port,
      'POST',
      '/api/session/snapshot',
      {
        host: `127.0.0.1:${server.port}`,
        origin: 'https://evil.example',
        'content-type': 'text/plain;charset=UTF-8',
      },
      '{"label":"from-evil"}',
    );
    expect(reply.status).toBe(403);
  });

  it('rejects a cross-site write that sends no Content-Type', async () => {
    const reply = await send(
      server.port,
      'POST',
      '/api/session/snapshot',
      { host: `127.0.0.1:${server.port}`, origin: 'https://evil.example' },
      '{"label":"from-evil"}',
    );
    expect(reply.status).toBe(403);
  });

  it('rejects a read whose Host is not a loopback name (DNS rebinding)', async () => {
    const reply = await send(server.port, 'GET', '/api/workspace', {
      host: `evil.example:${server.port}`,
    });
    expect(reply.status).toBe(403);
    expect(reply.body).not.toContain(workspace);
  });

  it('rejects a same-origin write from a rebound Host', async () => {
    const host = `evil.example:${server.port}`;
    const reply = await send(
      server.port,
      'POST',
      '/api/session/snapshot',
      { host, origin: `http://${host}`, 'content-type': 'text/plain;charset=UTF-8' },
      '{}',
    );
    expect(reply.status).toBe(403);
  });

  it('serves a read addressed to localhost', async () => {
    const reply = await send(server.port, 'GET', '/api/workspace', {
      host: `localhost:${server.port}`,
    });
    expect(reply.status).toBe(200);
  });
});
