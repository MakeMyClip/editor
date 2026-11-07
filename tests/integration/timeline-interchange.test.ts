import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildMcpServer } from '../../src/mcp/server.js';

// The unit tests feed the exporter probe results; this builds a cut over MCP
// from a real camera-style file (with a start timecode) and exports it three
// ways, checking the editor files run as long as the rendered mp4.
const IS_CI = process.env.CI === 'true';

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-interchange-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

function payload<T>(result: unknown): T {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return JSON.parse(content.find((c) => c.type === 'text')?.text ?? '{}') as T;
}

function xml(content: string): Element {
  return new DOMParser().parseFromString(content, 'text/xml').documentElement as unknown as Element;
}

interface Exported {
  exported?: string;
  files?: string[];
  durationSec?: number;
  notes?: string[];
  error?: string;
}

describe.skipIf(!IS_CI)('interchange export over MCP against real FFmpeg', () => {
  it('writes FCPXML and FCP7 XML that match the rendered cut', async () => {
    const path = join(workspace, 'camera.mov');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'testsrc=s=160x90:r=30:d=6'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=6'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
      ...['-timecode', '01:00:00:00', path],
    ]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>): Promise<Exported> =>
      payload<Exported>(await client.callTool({ name, arguments: args }));
    try {
      await call('timeline_edit', {
        verbs: [
          { verb: 'add_media', id: 'a', path, sourceInSec: 0, sourceOutSec: 2.5 },
          { verb: 'add_media', id: 'b', path, sourceInSec: 3, sourceOutSec: 6 },
          { verb: 'transition', afterClipId: 'a', kind: 'fade', durationSec: 0.5 },
          { verb: 'add_text', text: 'Hello', durationSec: 1, startSec: 0.5, track: 'captions' },
        ],
      });

      const fcp = await call('timeline_export', { format: 'fcpxml', output: 'cut.fcpxml' });
      expect(fcp.error).toBeUndefined();
      expect(fcp.exported).toBe(join(workspace, 'cut.fcpxml'));
      const root = xml(await readFile(join(workspace, 'cut.fcpxml'), 'utf8'));
      const asset = root.getElementsByTagName('asset')[0];
      // The camera's 01:00:00:00 at 30 fps.
      expect(asset?.getAttribute('start')).toBe('3600s');
      const clips = Array.from(root.getElementsByTagName('asset-clip'));
      // b starts 3s in, plus the 8 of the transition's 15 frames after the edit.
      expect(clips.map((c) => c.getAttribute('start'))).toEqual(['3600s', '54049/15s']);
      expect(root.getElementsByTagName('transition')).toHaveLength(1);
      expect(root.getElementsByTagName('title')).toHaveLength(1);

      const premiere = await call('timeline_export', { format: 'xmeml', output: 'cut.xml' });
      expect(premiere.files).toEqual([join(workspace, 'cut.xml'), join(workspace, 'cut.srt')]);
      expect(existsSync(join(workspace, 'cut.srt'))).toBe(true);
      const seq = xml(await readFile(join(workspace, 'cut.xml'), 'utf8'));
      expect(seq.getElementsByTagName('string')[1]?.textContent).toBe('01:00:00:00');

      // The editor files run exactly as long as the rendered mp4.
      const mp4 = await call('timeline_export', {});
      expect(mp4.error).toBeUndefined();
      expect(fcp.durationSec).toBeCloseTo(mp4.durationSec ?? 0, 6);
      expect(premiere.durationSec).toBeCloseTo(mp4.durationSec ?? 0, 6);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
