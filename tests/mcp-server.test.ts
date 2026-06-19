import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/mcp/server.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-mcp-test-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

/** Connect a fresh in-process client+server over a linked transport pair. */
async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const text = content.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('MCP server', () => {
  it('exposes the timeline tools', async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'timeline_edit',
        'timeline_export',
        'timeline_redo',
        'timeline_show',
        'timeline_undo',
      ]);
    } finally {
      await close();
    }
  });

  it('advertises its package version in the handshake', async () => {
    const { client, close } = await connect();
    try {
      expect(client.getServerVersion()?.version).toBe(pkg.version);
    } finally {
      await close();
    }
  });

  it('reports renderability (exportable + blockers) in timeline_show', async () => {
    const { client, close } = await connect();
    try {
      const show = payload(await client.callTool({ name: 'timeline_show', arguments: {} }));
      // An empty doc isn't renderable, but show must still answer — never throw.
      expect(show.exportable).toBe(false);
      expect(Array.isArray(show.blockers)).toBe(true);
      expect((show.blockers as string[]).length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('edits the document through verbs and is undoable — the same op-aware path', async () => {
    const { client, close } = await connect();
    try {
      // start empty
      const show0 = payload(await client.callTool({ name: 'timeline_show', arguments: {} }));
      expect(show0.tracks).toEqual([]);

      // add a text clip (no media file / FFmpeg needed)
      const edit = payload(
        await client.callTool({
          name: 'timeline_edit',
          arguments: { verbs: [{ verb: 'add_text', text: 'Hello', durationSec: 2 }] },
        }),
      );
      expect(edit.applied).toBeGreaterThan(0);
      const doc = edit.document as { tracks: { clips: unknown[] }[] };
      expect(doc.tracks[0]?.clips).toHaveLength(1);

      // show reflects it
      const show1 = payload(await client.callTool({ name: 'timeline_show', arguments: {} }));
      expect((show1.tracks as { clips: unknown[] }[])[0]?.clips).toHaveLength(1);

      // undo removes it; redo brings it back
      const undo = payload(await client.callTool({ name: 'timeline_undo', arguments: {} }));
      expect(undo.undone).toBe(true);
      const afterUndo = payload(await client.callTool({ name: 'timeline_show', arguments: {} }));
      expect((afterUndo.tracks as { clips: unknown[] }[])[0]?.clips ?? []).toHaveLength(0);

      const redo = payload(await client.callTool({ name: 'timeline_redo', arguments: {} }));
      expect(redo.redone).toBe(true);
    } finally {
      await close();
    }
  });

  it('rejects an invalid verb (Zod validates at the boundary)', async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({
        name: 'timeline_edit',
        arguments: { verbs: [{ verb: 'not_a_verb' }] },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('rejects set_transform — the MCP exposes only renderable verbs', async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({
        name: 'timeline_edit',
        arguments: { verbs: [{ verb: 'set_transform', clipId: 'c1', scale: 2 }] },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
    } finally {
      await close();
    }
  });
});
