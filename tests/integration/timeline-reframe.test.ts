import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probe } from '../../src/ffmpeg/probe.js';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildMcpServer } from '../../src/mcp/server.js';

const ffmpegPath = (): string => process.env.MAKEMYCLIP_FFMPEG_PATH ?? ffmpegStatic ?? 'ffmpeg';

// Unit tests assert the filter graph; this checks that the exported picture is
// the right shape and shows the part of the source the position asks for.
const IS_CI = process.env.CI === 'true';

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-reframe-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

/** Which of red/blue dominates the first frame of a video. */
async function dominant(video: string): Promise<'red' | 'blue'> {
  const { stdout } = await execa(
    ffmpegPath(),
    [
      ...['-hide_banner', '-loglevel', 'error', '-i', video, '-frames:v', '1'],
      ...['-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    ],
    { encoding: 'buffer' },
  );
  const [r = 0, , b = 0] = [...stdout];
  return r >= b ? 'red' : 'blue';
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return JSON.parse(content.find((c) => c.type === 'text')?.text ?? '{}');
}

describe.skipIf(!IS_CI)('timeline reframe against real FFmpeg', () => {
  it('exports a 16:9 clip as 9:16 showing the left, then the right, of the source', async () => {
    // 1s of 16:9 video: red left half, blue right half.
    const source = join(workspace, 'halves.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'color=c=red:s=320x360:r=30:d=1'],
      ...['-f', 'lavfi', '-i', 'color=c=blue:s=320x360:r=30:d=1'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1'],
      ...['-filter_complex', '[0:v][1:v]hstack=inputs=2[v]', '-map', '[v]', '-map', '2:a'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source],
    ]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const edit = payload(
        await client.callTool({
          name: 'timeline_edit',
          arguments: {
            verbs: [
              { verb: 'add_media', id: 'a', path: source },
              { verb: 'reframe', aspect: '9:16', x: 0 },
            ],
          },
        }),
      );
      expect((edit.document as { exportable: boolean }).exportable).toBe(true);

      const left = join(workspace, 'left.mp4');
      await client.callTool({ name: 'timeline_export', arguments: { output: left } });
      const info = await probe(left);
      expect(info.video).toMatchObject({ width: 1080, height: 1920 });
      expect(await dominant(left)).toBe('red');

      await client.callTool({
        name: 'timeline_edit',
        arguments: { verbs: [{ verb: 'set_framing', clipId: 'a', x: 1 }] },
      });
      const right = join(workspace, 'right.mp4');
      await client.callTool({ name: 'timeline_export', arguments: { output: right } });
      expect(await dominant(right)).toBe('blue');

      // The editor-project export refuses the crop instead of dropping it.
      const project = payload(
        await client.callTool({
          name: 'timeline_export',
          arguments: { format: 'fcpxml', output: join(workspace, 'cut.fcpxml') },
        }),
      );
      expect(String(project.error)).toMatch(/reframed/);
    } finally {
      await client.close();
      await server.close();
    }
  }, 60_000);
});
