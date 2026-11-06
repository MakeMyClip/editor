import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSpeechAudioArgs } from '../src/ffmpeg/args/speech-audio.js';
import type { MediaInfo } from '../src/timeline/compile.js';
import { emptyComposition } from '../src/timeline/composition.js';
import { applyOps, mediaClip, textClip, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import {
  clipWords,
  type Transcript,
  TranscriptError,
  transcribeClip,
  transcribeMedia,
  transcriptPath,
} from '../src/timeline/transcript.js';
import {
  buildWhisperArgs,
  parseWhisperJson,
  resolveWhisper,
  runWhisper,
  TranscriptionUnavailableError,
  WhisperLanguageSchema,
} from '../src/transcribe/whisper.js';
import { WorkspaceBoundaryError } from '../src/workspace.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;

let workspace: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MAKEMYCLIP_WORKSPACE', 'MAKEMYCLIP_WHISPER_MODEL', 'MAKEMYCLIP_WHISPER_PATH'];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-transcript-'));
  for (const key of ENV) saved[key] = process.env[key];
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
  delete process.env.MAKEMYCLIP_WHISPER_MODEL;
  delete process.env.MAKEMYCLIP_WHISPER_PATH;
});

afterEach(async () => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(workspace, { recursive: true, force: true });
});

// whisper.cpp 1.9.5 `-ml 1 -sow -oj` output for synthetic speech (macOS `say`).
const WHISPER_JSON = {
  params: { model: 'models/ggml-tiny.en.bin', language: 'en', translate: false },
  result: { language: 'en' },
  transcription: [
    {
      timestamps: { from: '00:00:00,000', to: '00:00:00,040' },
      offsets: { from: 0, to: 40 },
      text: '',
    },
    {
      timestamps: { from: '00:00:00,040', to: '00:00:00,360' },
      offsets: { from: 40, to: 360 },
      text: ' Hello',
    },
    {
      timestamps: { from: '00:00:00,360', to: '00:00:01,080' },
      offsets: { from: 360, to: 1080 },
      text: ' there,',
    },
    {
      timestamps: { from: '00:00:01,080', to: '00:00:01,350' },
      offsets: { from: 1080, to: 1350 },
      text: ' this',
    },
  ],
};

describe('whisper.cpp', () => {
  it('asks for one word per segment as JSON, nothing printed', () => {
    expect(
      buildWhisperArgs({
        model: '/m/base.bin',
        input: '/w/a.wav',
        outBase: '/w/a',
        language: 'auto',
      }),
    ).toEqual([
      '-m',
      '/m/base.bin',
      '-f',
      '/w/a.wav',
      '-l',
      'auto',
      '-ml',
      '1',
      '-sow',
      '-oj',
      '-of',
      '/w/a',
      '-np',
    ]);
  });

  it('parses words in seconds, dropping empty segments', () => {
    expect(parseWhisperJson(WHISPER_JSON)).toEqual({
      language: 'en',
      words: [
        { text: 'Hello', startSec: 0.04, endSec: 0.36 },
        { text: 'there,', startSec: 0.36, endSec: 1.08 },
        { text: 'this', startSec: 1.08, endSec: 1.35 },
      ],
    });
  });

  it('is unavailable, with setup steps, until a model is configured', async () => {
    expect(() => resolveWhisper()).toThrow(TranscriptionUnavailableError);
    expect(() => resolveWhisper()).toThrow(/brew install whisper-cpp/);
    expect(() => resolveWhisper('/nope/ggml.bin')).toThrow(/does not exist/);
    const model = join(workspace, 'ggml-tiny.en.bin');
    await writeFile(model, 'x');
    process.env.MAKEMYCLIP_WHISPER_MODEL = model;
    expect(resolveWhisper()).toEqual({ binary: 'whisper-cli', model });
    process.env.MAKEMYCLIP_WHISPER_PATH = '/opt/whisper/bin/whisper-cli';
    expect(resolveWhisper().binary).toBe('/opt/whisper/bin/whisper-cli');
  });

  it('turns a missing binary into the setup error', async () => {
    await expect(runWhisper(join(workspace, 'no-whisper'), [])).rejects.toBeInstanceOf(
      TranscriptionUnavailableError,
    );
  });

  it('accepts language codes and auto, nothing else', () => {
    expect(WhisperLanguageSchema.parse('en')).toBe('en');
    expect(WhisperLanguageSchema.parse('auto')).toBe('auto');
    expect(() => WhisperLanguageSchema.parse('-m')).toThrow();
    expect(() => WhisperLanguageSchema.parse('english')).toThrow();
  });

  it('extracts the first audio stream as 16 kHz mono WAV', () => {
    expect(buildSpeechAudioArgs({ input: '/w/talk.mp4', output: '/w/a.wav' })).toEqual([
      ...['-y', '-hide_banner', '-loglevel', 'error', '-i', '/w/talk.mp4', '-map', '0:a:0'],
      ...['-af', 'aresample=async=1:first_pts=0'],
      ...['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '/w/a.wav'],
    ]);
  });
});

const transcript = (words: Transcript['words']): Transcript => ({
  version: 1,
  mediaId: M,
  language: 'en',
  source: 'whisper-cpp',
  model: 'ggml-tiny.en.bin',
  modelKey: '',
  requestedLanguage: 'auto',
  sourceSize: 0,
  sourceMtimeMs: 0,
  words,
});

describe('clipWords', () => {
  it("places the clip's words on the timeline, clipping words at its edges", () => {
    const t = transcript([
      { text: 'Hello', startSec: 0.04, endSec: 0.36 },
      { text: 'there,', startSec: 0.36, endSec: 1.08 },
      { text: 'this', startSec: 1.08, endSec: 1.35 },
      { text: 'test', startSec: 3.9, endSec: 4.3 },
      { text: 'later', startSec: 5, endSec: 5.5 },
    ]);
    const clip = mediaClip({ id: 'c', mediaId: M, sourceInSec: 1, sourceOutSec: 4, startSec: 10 });
    expect(clipWords(t, clip)).toEqual([
      { index: 1, text: 'there,', startSec: 10, endSec: 10.08 },
      { index: 2, text: 'this', startSec: 10.08, endSec: 10.35 },
      { index: 3, text: 'test', startSec: 12.9, endSec: 13 },
    ]);
  });
});

describe('transcribeMedia / transcribeClip', () => {
  async function setup(): Promise<{ info: MediaInfo; model: string }> {
    const source = join(workspace, 'talk.mp4');
    await writeFile(source, 'video bytes');
    const model = join(workspace, 'ggml-tiny.en.bin');
    await writeFile(model, 'model bytes');
    process.env.MAKEMYCLIP_WHISPER_MODEL = model;
    // Any run would fail: reuse must not run whisper at all.
    process.env.MAKEMYCLIP_WHISPER_PATH = join(workspace, 'no-whisper');
    return { info: { path: source, hasAudio: true }, model };
  }

  /** A stored transcript made from the current source with `model`, asked for `language`. */
  async function store(info: MediaInfo, model: string, language: string): Promise<Transcript> {
    const source = await stat(info.path);
    const m = await stat(model);
    const stored = {
      ...transcript([{ text: 'Hello', startSec: 0, endSec: 0.3 }]),
      modelKey: `${model}:${m.size}:${m.mtimeMs}`,
      requestedLanguage: language,
      sourceSize: source.size,
      sourceMtimeMs: source.mtimeMs,
    };
    await mkdir(join(workspace, 'transcripts'), { recursive: true });
    await writeFile(transcriptPath(M), JSON.stringify(stored));
    return stored;
  }

  it('reuses the stored transcript while the file, model and language request match', async () => {
    const { info, model } = await setup();
    const stored = await store(info, model, 'auto');
    await expect(transcribeMedia(M, info)).resolves.toEqual(stored);
  });

  // A miss tries to transcribe again; with this fake source the audio
  // extraction fails, which is how these tests see that nothing was reused.
  it('transcribes again for a different model file with the same name', async () => {
    const { info, model } = await setup();
    await store(info, model, 'auto');
    const other = join(workspace, 'other');
    await mkdir(other);
    await writeFile(join(other, 'ggml-tiny.en.bin'), 'other model bytes');
    await expect(
      transcribeMedia(M, info, { model: join(other, 'ggml-tiny.en.bin') }),
    ).rejects.toThrow();
  });

  it('transcribes again when the language request changes, auto included', async () => {
    const { info, model } = await setup();
    await store(info, model, 'en');
    await expect(transcribeMedia(M, info)).rejects.toThrow();
    await store(info, model, 'auto');
    await expect(transcribeMedia(M, info, { language: 'en' })).rejects.toThrow();
  });

  it('transcribes again when the source file changes', async () => {
    const { info, model } = await setup();
    await store(info, model, 'auto');
    await writeFile(info.path, 'edited video bytes');
    await expect(transcribeMedia(M, info)).rejects.toThrow();
  });

  it('refuses a transcripts folder that is a symlink out of the workspace', async () => {
    const { info } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'mmc-outside-'));
    try {
      await symlink(outside, join(workspace, 'transcripts'));
      await expect(transcribeMedia(M, info)).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses clips that have no speech to transcribe', async () => {
    const { info } = await setup();
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: textClip({ id: 't', text: 'hi', durationSec: 1, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c', mediaId: M, sourceOutSec: 1, startSec: 1 }),
      },
    ]);
    const silent = new Map([[M, { ...info, hasAudio: false }]]);
    await expect(transcribeClip(comp, 'nope', silent)).rejects.toBeInstanceOf(TranscriptError);
    await expect(transcribeClip(comp, 't', silent)).rejects.toThrow(/only media clips/);
    await expect(transcribeClip(comp, 'c', silent)).rejects.toThrow(/no audio/);
    await expect(transcribeClip(comp, 'c', new Map())).rejects.toThrow(/No media registered/);
  });
});
