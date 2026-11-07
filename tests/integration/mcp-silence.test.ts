import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildMcpServer } from '../../src/mcp/server.js';

// The unit tests stub the analysis; this drives remove_silence through the MCP
// server against real FFmpeg, then undoes it the way any client would.
const IS_CI = process.env.CI === 'true';

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-mcp-silence-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

interface Summary {
  tracks: { clips: { id: string; startSec: number; endSec: number }[] }[];
}

function payload<T>(result: unknown): T {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return JSON.parse(content.find((c) => c.type === 'text')?.text ?? '{}') as T;
}

describe.skipIf(!IS_CI)('remove_silence over MCP against real FFmpeg', () => {
  it('cuts the pauses as one edit and a single undo restores the clip', async () => {
    // 6s: a tone for the first 1.5s of every 3s, silence otherwise.
    const path = join(workspace, 'pauses.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'color=c=black:s=96x64:r=10:d=6'],
      ...['-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,3),1.5),0.5*sin(2*PI*440*t),0)':s=48000:d=6"],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path],
    ]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: 'timeline_edit',
        arguments: { verbs: [{ verb: 'add_media', id: 'c1', path }] },
      });

      const cut = payload<{ applied: number; document: Summary }>(
        await client.callTool({
          name: 'timeline_edit',
          arguments: { verbs: [{ verb: 'remove_silence', clipId: 'c1' }] },
        }),
      );
      expect(cut.applied).toBe(1);
      const clips = cut.document.tracks[0]?.clips ?? [];
      expect(clips).toHaveLength(2);
      expect(clips[1]?.endSec).toBeCloseTo(3.3, 1);

      const undo = payload<{ undone: boolean; label: string }>(
        await client.callTool({ name: 'timeline_undo', arguments: {} }),
      );
      expect(undo).toMatchObject({ undone: true, label: 'silenceCut' });
      const shown = payload<Summary>(
        await client.callTool({ name: 'timeline_show', arguments: {} }),
      );
      expect(shown.tracks[0]?.clips.map((c) => [c.id, c.endSec])).toEqual([['c1', 6]]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
