import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { buildMcpServer } from '../../src/mcp/server.js';

// Runs the real whisper.cpp on synthetic speech. Transcription is optional, so
// this needs a model (MAKEMYCLIP_WHISPER_MODEL) and whisper-cli, and macOS
// `say` to make the speech without committing an audio fixture.
const CAN_RUN = Boolean(process.env.MAKEMYCLIP_WHISPER_MODEL) && process.platform === 'darwin';

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-whisper-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

interface ClipTranscript {
  text: string;
  words: { index: number; text: string; startSec: number; endSec: number }[];
}

describe.skipIf(!CAN_RUN)('timeline_transcript against real whisper.cpp', () => {
  it("returns a trimmed clip's words on the timeline and reuses the transcript", async () => {
    const speech = join(workspace, 'speech.aiff');
    await execa('say', ['-o', speech, 'Hello there. This is a short test of the editor.']);
    const talk = join(workspace, 'talk.mp4');
    await runFfmpeg([
      ...[
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=160x120:r=30:d=6',
      ],
      ...['-i', speech, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk],
    ]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    const transcribe = async (): Promise<ClipTranscript> => {
      const result = await client.callTool({
        name: 'timeline_transcript',
        arguments: { clipId: 'c' },
      });
      const content = result.content as { type: string; text?: string }[];
      return JSON.parse(content[0]?.text ?? '{}') as ClipTranscript;
    };
    try {
      // The clip starts 1 s into the source, at timeline 2 s after a 2 s card.
      await client.callTool({
        name: 'timeline_edit',
        arguments: {
          verbs: [
            { verb: 'add_color', durationSec: 2 },
            { verb: 'add_media', id: 'c', path: talk, sourceInSec: 1, sourceOutSec: 4 },
          ],
        },
      });

      const first = await transcribe();
      expect(first.text.toLowerCase()).toContain('test');
      for (const w of first.words) {
        expect(w.startSec).toBeGreaterThanOrEqual(2);
        expect(w.endSec).toBeLessThanOrEqual(5);
      }
      expect(await transcribe()).toEqual(first);
      expect((await readdir(workspace)).filter((f) => f.startsWith('.transcribe'))).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
