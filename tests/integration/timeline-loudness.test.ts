import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probe } from '../../src/ffmpeg/probe.js';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildMcpServer } from '../../src/mcp/server.js';

// Unit tests stub FFmpeg; this checks the exported file's loudness with an
// independent meter (ebur128), not loudnorm's own report.
const IS_CI = process.env.CI === 'true';

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-loudness-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

/** Integrated loudness of a file, LUFS, measured by ebur128. */
async function integratedLufs(path: string): Promise<number> {
  const { stderr } = await runFfmpeg([
    ...['-hide_banner', '-nostats', '-i', path, '-map', '0:a:0'],
    ...['-af', 'ebur128', '-f', 'null', '-'],
  ]);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const match = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  if (!match?.[1]) throw new Error(`No integrated loudness in:\n${summary}`);
  return Number(match[1]);
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return JSON.parse(content.find((c) => c.type === 'text')?.text ?? '{}');
}

describe.skipIf(!IS_CI)('timeline loudness against real FFmpeg', () => {
  it('exports at the target loudness without changing the length', async () => {
    // 12s of a quiet tone stepping between two levels (about -26 LUFS).
    const source = join(workspace, 'quiet.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=12'],
      ...[
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='(0.05+0.05*lt(mod(t,4),2))*sin(2*PI*220*t)':s=48000:d=12",
      ],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source],
    ]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: 'timeline_edit',
        arguments: { verbs: [{ verb: 'add_media', path: source }] },
      });
      const plain = join(workspace, 'plain.mp4');
      await client.callTool({ name: 'timeline_export', arguments: { output: plain } });

      await client.callTool({
        name: 'timeline_edit',
        arguments: { verbs: [{ verb: 'set_loudness', targetLufs: -14 }] },
      });
      const loud = join(workspace, 'loud.mp4');
      const result = payload(
        await client.callTool({ name: 'timeline_export', arguments: { output: loud } }),
      );
      const loudness = result.loudness as { mode: string; inputLufs: number; outputLufs: number };
      expect(loudness.mode).not.toBe('skipped');
      expect(loudness.inputLufs).toBeLessThan(-20);

      expect(Math.abs((await integratedLufs(loud)) + 14)).toBeLessThan(1);
      expect(await integratedLufs(plain)).toBeLessThan(-20);
      const [a, b] = [await probe(plain), await probe(loud)];
      expect(Math.abs(a.durationSec - b.durationSec)).toBeLessThan(0.05);
      expect(b.video).toMatchObject({ width: a.video?.width, height: a.video?.height });
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
});
