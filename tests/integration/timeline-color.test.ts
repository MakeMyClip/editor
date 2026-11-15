import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { mutateComposition } from '../../src/timeline/document-store.js';

const ffmpegPath = (): string => process.env.MAKEMYCLIP_FFMPEG_PATH ?? ffmpegStatic ?? 'ffmpeg';

// Unit tests assert the compiler refuses a color that is filter syntax; this
// checks that such a value is live in real FFmpeg (it writes a file outside the
// workspace) and that the MCP edit and export paths never hand it over.
const IS_CI = process.env.CI === 'true';

let workspace: string;
let outside: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-color-'));
  outside = await mkdtemp(join(tmpdir(), 'mmc-outside-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** The average RGB of a video's first frame. */
async function firstFrameRgb(video: string): Promise<number[]> {
  const { stdout } = await execa(
    ffmpegPath(),
    [
      ...['-hide_banner', '-loglevel', 'error', '-i', video, '-frames:v', '1'],
      ...['-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    ],
    { encoding: 'buffer' },
  );
  return [...stdout];
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return JSON.parse(content.find((c) => c.type === 'text')?.text ?? '{}');
}

describe.skipIf(!IS_CI)('timeline colors against real FFmpeg', () => {
  it('refuses a color that adds a filter, which FFmpeg would otherwise run', async () => {
    const written = join(outside, 'written.txt');
    const hostile = `black,metadata=mode=print:file=${written}`;

    // Control: placed in pad= as the old compiler placed a background, it creates a file.
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16'],
      ...['-vf', `pad=16:16:0:0:color=${hostile},setsar=1`, '-frames:v', '1', '-f', 'null', '-'],
    ]);
    expect(await exists(written)).toBe(true);
    await rm(written);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const refused = await client.callTool({
        name: 'timeline_edit',
        arguments: { verbs: [{ verb: 'add_color', durationSec: 1, color: hostile }] },
      });
      expect((refused as { isError?: boolean }).isError).toBe(true);

      await client.callTool({
        name: 'timeline_edit',
        arguments: { verbs: [{ verb: 'add_color', durationSec: 1, color: '#12ab34' }] },
      });
      // A stored document can still carry one (a hand edit, an older version).
      await mutateComposition([{ op: 'setCanvas', width: 320, height: 240, background: hostile }]);

      const out = join(workspace, 'out.mp4');
      const blocked = payload(
        await client.callTool({ name: 'timeline_export', arguments: { output: out } }),
      );
      expect(String(blocked.error)).toMatch(/^Canvas background ".*" is not a color\./);
      expect(await exists(out)).toBe(false);
      expect(await exists(written)).toBe(false);

      // The valid colors still render: '#12ab34' reaches FFmpeg as 0x12ab34.
      await mutateComposition([{ op: 'setCanvas', background: 'black' }]);
      const exported = payload(
        await client.callTool({ name: 'timeline_export', arguments: { output: out } }),
      );
      expect(exported.error).toBeUndefined();
      const [r = 0, g = 0, b = 0] = await firstFrameRgb(out);
      expect(Math.abs(r - 0x12)).toBeLessThan(12);
      expect(Math.abs(g - 0xab)).toBeLessThan(12);
      expect(Math.abs(b - 0x34)).toBeLessThan(12);
    } finally {
      await client.close();
      await server.close();
    }
  }, 60_000);
});
