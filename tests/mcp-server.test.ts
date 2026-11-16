import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/mcp/server.js';
import { appendOp } from '../src/session/store.js';
import { mutateComposition, readComposition } from '../src/timeline/document-store.js';
import { mediaClip, videoTrack } from '../src/timeline/ops.js';
import { makeMediaId } from '../src/timeline/schema.js';
import type { Transcript } from '../src/timeline/transcript.js';

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
        'doctor',
        'timeline_check',
        'timeline_edit',
        'timeline_export',
        'timeline_redo',
        'timeline_show',
        'timeline_transcript',
        'timeline_undo',
      ]);
    } finally {
      await close();
    }
  });

  it('answers "is my setup OK?" with the doctor checks', async () => {
    const { client, close } = await connect();
    try {
      const report = payload(await client.callTool({ name: 'doctor', arguments: {} }));
      const checks = report.checks as { id: string; status: string }[];
      expect(typeof report.ok).toBe('boolean');
      expect(checks.map((c) => c.id)).toEqual([
        'node',
        'ffmpeg',
        'drawtext',
        'vidstab',
        'workspace',
        'font',
        'whisper',
        'whisper-model',
      ]);
      expect(checks.find((c) => c.id === 'workspace')?.status).toBe('ok');
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

  it('reframes the canvas to 9:16 and reports the new shape', async () => {
    const { client, close } = await connect();
    try {
      const edit = payload(
        await client.callTool({
          name: 'timeline_edit',
          arguments: {
            verbs: [
              { verb: 'add_color', durationSec: 2 },
              { verb: 'reframe', aspect: '9:16' },
            ],
          },
        }),
      );
      const doc = edit.document as { canvas: unknown; exportable: boolean };
      expect(doc.canvas).toEqual({ width: 1080, height: 1920, fps: 30, fit: 'cover' });
      expect(doc.exportable).toBe(true);

      const loud = payload(
        await client.callTool({
          name: 'timeline_edit',
          arguments: { verbs: [{ verb: 'set_loudness', targetLufs: -14 }] },
        }),
      );
      expect((loud.document as { loudness: unknown }).loudness).toEqual({ targetLufs: -14 });
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

  it('exports to an editor file only inside the workspace, and refuses an empty timeline', async () => {
    const { client, close } = await connect();
    try {
      const outside = payload(
        await client.callTool({
          name: 'timeline_export',
          arguments: { format: 'fcpxml', output: join(tmpdir(), 'escape.fcpxml') },
        }),
      );
      expect(String(outside.error)).toMatch(/outside the workspace/);
      const empty = payload(
        await client.callTool({ name: 'timeline_export', arguments: { format: 'xmeml' } }),
      );
      expect(String(empty.error)).toMatch(/Nothing to export/);
    } finally {
      await close();
    }
  });
});

describe('MCP shorts (named timelines)', () => {
  /** Main holds a 30 s registered recording with a stored transcript: nothing renders. */
  async function recordingOnMain(): Promise<{ mediaId: string }> {
    const source = join(workspace, 'talk.mp4');
    await writeFile(source, 'video bytes');
    const mediaId = makeMediaId(source);
    await appendOp({
      tool: 'ingest',
      args: { path: source },
      result: {
        mediaId,
        ref: { path: source, durationSec: 30, audio: { codec: 'aac' }, video: { codec: 'h264' } },
      },
    });
    const file = await stat(source);
    const transcript: Transcript = {
      version: 1,
      mediaId,
      language: 'en',
      source: 'whisper-cpp',
      model: 'ggml-tiny.en.bin',
      modelKey: 'fixture',
      requestedLanguage: 'auto',
      sourceSize: file.size,
      sourceMtimeMs: file.mtimeMs,
      words: Array.from({ length: 20 }, (_, i) => ({
        text: `word${i}`,
        startSec: i + 1,
        endSec: i + 1.5,
      })),
    };
    await mkdir(join(workspace, 'transcripts'), { recursive: true });
    await writeFile(join(workspace, 'transcripts', `${mediaId}.json`), JSON.stringify(transcript));
    await mutateComposition([
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId, sourceOutSec: 30, startSec: 0 }),
      },
    ]);
    return { mediaId };
  }

  it('makes a short on its own timeline with timeline_edit, leaving main alone', async () => {
    await recordingOnMain();
    const mainBefore = await readComposition();
    const { client, close } = await connect();
    try {
      const edit = payload(
        await client.callTool({
          name: 'timeline_edit',
          arguments: {
            timeline: 'clip-1',
            verbs: [
              {
                verb: 'make_short',
                ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 6 }],
                x: 0.4,
              },
            ],
          },
        }),
      );
      expect(edit.warnings).toEqual([
        'Range 1 starts mid-sentence, between "word1" and "word2" (word 2).',
        'Range 1 ends mid-sentence, between "word6" and "word7" (word 6).',
        // The fixture's "video" is a few bytes, which FFmpeg can't measure.
        "Range 1: its audio couldn't be measured, so its edges follow the transcript. Look at it or listen.",
      ]);
      const doc = edit.document as Record<string, unknown>;
      expect(doc.timeline).toBe('clip-1');
      expect(doc.canvas).toMatchObject({ width: 1080, height: 1920, fit: 'cover' });
      expect(doc.loudness).toEqual({ targetLufs: -14 });
      expect(doc.exportable).toBe(true);
      expect((doc.tracks as { id: string }[]).map((t) => t.id)).toEqual(['v0', 'captions']);
      expect(await readComposition()).toEqual(mainBefore);

      const show = payload(await client.callTool({ name: 'timeline_show', arguments: {} }));
      expect(show.timeline).toBe('main');
      expect(show.timelines).toEqual(['main', 'clip-1']);

      const undo = payload(
        await client.callTool({ name: 'timeline_undo', arguments: { timeline: 'clip-1' } }),
      );
      expect(undo.undone).toBe(true);
      const emptied = payload(
        await client.callTool({ name: 'timeline_show', arguments: { timeline: 'clip-1' } }),
      );
      expect(emptied.tracks).toEqual([]);
      expect((await readComposition()).rev).toBe(mainBefore.rev);
    } finally {
      await close();
    }
  });

  it("outlines the timeline's sentences without a clipId, compactly", async () => {
    const { mediaId } = await recordingOnMain();
    // A configured model the stored transcript matches, so nothing is transcribed.
    const model = join(workspace, 'ggml-base.en.bin');
    await writeFile(model, 'model bytes');
    const m = await stat(model);
    const transcriptFile = join(workspace, 'transcripts', `${mediaId}.json`);
    const stored = JSON.parse(await readFile(transcriptFile, 'utf8')) as Transcript;
    await writeFile(
      transcriptFile,
      JSON.stringify({ ...stored, modelKey: `${model}:${m.size}:${m.mtimeMs}` }),
    );
    const env = {
      model: process.env.MAKEMYCLIP_WHISPER_MODEL,
      path: process.env.MAKEMYCLIP_WHISPER_PATH,
    };
    process.env.MAKEMYCLIP_WHISPER_MODEL = model;
    process.env.MAKEMYCLIP_WHISPER_PATH = join(workspace, 'no-whisper');
    const { client, close } = await connect();
    try {
      const result = (await client.callTool({ name: 'timeline_transcript', arguments: {} })) as {
        content: { type: string; text: string }[];
      };
      const text = result.content[0]?.text ?? '';
      expect(text).not.toContain('\n');
      const outline = JSON.parse(text) as {
        sentences: { clipId: string; fromIndex: number; toIndex: number; text: string }[];
        transcriptIds: Record<string, string>;
        nextFromSec?: number;
      };
      expect(outline.sentences).toEqual([
        expect.objectContaining({ clipId: 'c1', fromIndex: 0, toIndex: 19 }),
      ]);
      expect(Object.values(outline.transcriptIds)).toHaveLength(1);
      expect(outline.nextFromSec).toBeUndefined();

      const noClip = payload(
        await client.callTool({ name: 'timeline_transcript', arguments: { view: 'words' } }),
      );
      expect(noClip.error).toMatch(/needs a clipId/);
    } finally {
      await close();
      for (const [key, value] of [
        ['MAKEMYCLIP_WHISPER_MODEL', env.model],
        ['MAKEMYCLIP_WHISPER_PATH', env.path],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('answers a missing timeline or a short on main with an error', async () => {
    await recordingOnMain();
    const { client, close } = await connect();
    try {
      for (const name of ['timeline_show', 'timeline_check', 'timeline_undo', 'timeline_export']) {
        const result = payload(await client.callTool({ name, arguments: { timeline: 'nope' } }));
        expect(result.error).toMatch(/No timeline "nope"/);
      }
      const typo = payload(
        await client.callTool({
          name: 'timeline_edit',
          arguments: { timeline: 'nope', verbs: [{ verb: 'remove', clipId: 'c1' }] },
        }),
      );
      expect(typo.error).toMatch(/No timeline "nope"/);

      const onMain = payload(
        await client.callTool({
          name: 'timeline_edit',
          arguments: {
            verbs: [{ verb: 'make_short', ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 6 }] }],
          },
        }),
      );
      expect(onMain.error).toMatch(/not main/);

      const badId = await client.callTool({
        name: 'timeline_show',
        arguments: { timeline: '../main' },
      });
      expect(badId.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
