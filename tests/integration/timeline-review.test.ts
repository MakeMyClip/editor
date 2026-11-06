import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import type { MediaInfo } from '../../src/timeline/compile.js';
import { emptyComposition } from '../../src/timeline/composition.js';
import { applyOps, mediaClip, videoTrack } from '../../src/timeline/ops.js';
import { renderCutSheet, reviewCuts } from '../../src/timeline/review.js';
import type { MediaId } from '../../src/timeline/schema.js';

const ffmpegPath = (): string => process.env.MAKEMYCLIP_FFMPEG_PATH ?? ffmpegStatic ?? 'ffmpeg';

// Unit tests stub the meter; this checks real audio at real cuts and that the
// MCP client gets pictures back, not just text.
const IS_CI = process.env.CI === 'true';

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-review-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];

/** Which of red/green/blue dominates the 320x180 sheet cell at x. */
async function dominant(sheet: string, x: number): Promise<'red' | 'green' | 'blue'> {
  const { stdout } = await execa(
    ffmpegPath(),
    [
      ...['-hide_banner', '-loglevel', 'error', '-i', sheet],
      ...['-vf', `crop=320:180:${x}:0,scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    ],
    { encoding: 'buffer' },
  );
  const [r = 0, g = 0, b = 0] = [...stdout];
  return r >= g && r >= b ? 'red' : g >= b ? 'green' : 'blue';
}

describe.skipIf(!IS_CI)('timeline review against real FFmpeg', () => {
  it('flags a cut planted mid-tone, passes one at a pause, and returns images over MCP', async () => {
    // 6s: a tone for the first 1.5s of every 3s, silence otherwise.
    const path = join(workspace, 'pauses.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error'],
      ...['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=6'],
      ...['-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,3),1.5),0.5*sin(2*PI*440*t),0)':s=48000:d=6"],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path],
    ]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      // a [0,1) ends mid-tone → b [3.2,4) starts mid-tone; b → c [2,2.6) joins two pauses.
      await client.callTool({
        name: 'timeline_edit',
        arguments: {
          verbs: [
            { verb: 'add_media', id: 'a', path, sourceInSec: 0, sourceOutSec: 1 },
            { verb: 'add_media', id: 'b', path, sourceInSec: 3.2, sourceOutSec: 4.6 },
            { verb: 'add_media', id: 'c', path, sourceInSec: 2, sourceOutSec: 2.6 },
          ],
        },
      });

      const check = (await client.callTool({ name: 'timeline_check', arguments: {} }))
        .content as Content;
      const report = JSON.parse(check[0]?.text ?? '{}') as {
        cuts: { outClipId: string; flagged: boolean }[];
        flagged: number;
        sheet: { cuts: number } | null;
      };
      expect(report.cuts.map((c) => [c.outClipId, c.flagged])).toEqual([
        ['a', true],
        ['b', false],
      ]);
      expect(report.sheet).toMatchObject({ cuts: 2 });
      expect(check[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
      expect(Buffer.from(check[1]?.data ?? '', 'base64').subarray(0, 2)).toEqual(
        Buffer.from([0xff, 0xd8]),
      );

      const shown = (await client.callTool({ name: 'timeline_show', arguments: { atSec: 0.5 } }))
        .content as Content;
      expect(shown[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });

      // Scratch stills, frames and sheets are all cleaned up.
      expect((await readdir(workspace)).filter((f) => /cut-sheet|mcp-frame|tl-/.test(f))).toEqual(
        [],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps both stills of a cut between a 24 fps landscape clip and a portrait clip', async () => {
    // Red 24 fps landscape, then blue 30 fps portrait. One composition frame
    // (1/30 s) before 1.0 s is past the red clip's last frame (23/24 s), and
    // the two sizes differ: either bug drops or misplaces a cell.
    const red = join(workspace, 'red.mp4');
    const blue = join(workspace, 'blue.mp4');
    for (const [path, src] of [
      [red, 'color=c=red:s=320x180:r=24:d=2'],
      [blue, 'color=c=blue:s=180x320:r=30:d=2'],
    ] as const) {
      // Different chroma formats too: yuv420p next to yuv444p.
      const pixFmt = path === red ? 'yuv420p' : 'yuv444p';
      await runFfmpeg([
        ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src],
        ...['-c:v', 'libx264', '-pix_fmt', pixFmt, path],
      ]);
    }
    const R = 'm_aaaaaaaaaaaa' as MediaId;
    const B = 'm_bbbbbbbbbbbb' as MediaId;
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'r', mediaId: R, sourceOutSec: 1, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: B, sourceOutSec: 1, startSec: 1 }),
      },
    ]);
    const media = new Map<MediaId, MediaInfo>([
      [R, { path: red, hasAudio: false }],
      [B, { path: blue, hasAudio: false }],
    ]);

    const sheet = await renderCutSheet(comp, media, join(workspace, 'sheet.jpg'), workspace);
    expect(sheet).toMatchObject({ cuts: 1, truncated: false });

    // Left cell red, right cell blue.
    expect(await dominant(join(workspace, 'sheet.jpg'), 0)).toBe('red');
    expect(await dominant(join(workspace, 'sheet.jpg'), 320)).toBe('blue');
  });

  it("uses a sparse source's last frame before the cut, not the next one", async () => {
    // 1 fps: a red frame at 0 s, then blue frames from 1 s. A clip cut at 0.8 s
    // has only the red frame; the next frame (blue, 1 s) is past the cut.
    const sparse = join(workspace, 'sparse.mp4');
    await runFfmpeg([
      ...['-hide_banner', '-loglevel', 'error', '-filter_complex'],
      'color=c=red:s=320x180:r=1:d=1[a];color=c=blue:s=320x180:r=1:d=3[b];[a][b]concat=n=2:v=1:a=0',
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', sparse],
    ]);
    const S = 'm_dddddddddddd' as MediaId;
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'x', mediaId: S, sourceOutSec: 0.8, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'y', mediaId: S, sourceInSec: 2, sourceOutSec: 3, startSec: 0.8 }),
      },
    ]);
    const media = new Map<MediaId, MediaInfo>([[S, { path: sparse, hasAudio: false }]]);
    await renderCutSheet(comp, media, join(workspace, 'sparse.jpg'), workspace);
    expect(await dominant(join(workspace, 'sparse.jpg'), 0)).toBe('red');
    expect(await dominant(join(workspace, 'sparse.jpg'), 320)).toBe('blue');

    // An incoming clip [0.1, 0.8) holds no frame (0 s is before it, 1 s after):
    // the sheet is refused rather than showing footage outside the clip.
    const noFrame = applyOps(comp, [
      { op: 'setTrim', clipId: 'y', sourceInSec: 0.1, sourceOutSec: 0.8 },
    ]);
    const review = await reviewCuts(noFrame, media, join(workspace, 'nf.jpg'), workspace);
    expect(review.sheetError).toContain('No frame found in clip "y"');
  });

  it('keeps the audio report when FFmpeg cannot draw the sheet', async () => {
    const broken = join(workspace, 'broken.mp4');
    await writeFile(broken, 'not a video');
    const M = 'm_cccccccccccc' as MediaId;
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'x', mediaId: M, sourceOutSec: 1, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'y', mediaId: M, sourceOutSec: 1, startSec: 1 }),
      },
    ]);
    const media = new Map<MediaId, MediaInfo>([[M, { path: broken, hasAudio: false }]]);
    const review = await reviewCuts(comp, media, join(workspace, 'sheet.jpg'), workspace);
    expect(review.cuts).toHaveLength(1);
    expect(review.sheet).toBeNull();
    expect(review.sheetError).toBeTruthy();
    expect((await readdir(workspace)).filter((f) => f.startsWith('.cut-sheet'))).toEqual([]);
  });
});
