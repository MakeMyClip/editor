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
  findRetakes,
  planWordCut,
  storedTranscriptForClip,
  type Transcript,
  TranscriptError,
  transcribeClip,
  transcribeMedia,
  transcriptIdOf,
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
    // An installed whisper-cli resolves to its full path (Homebrew's on a Mac).
    expect(resolveWhisper()).toEqual({ binary: expect.stringMatching(/whisper-cli$/), model });
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

const word = (index: number, text: string) => ({ index, text, startSec: index, endSec: index + 1 });

describe('findRetakes', () => {
  it('finds a phrase said twice in a row and reports the earlier take', () => {
    const words = [
      'So,',
      'today',
      'I',
      'want',
      'to',
      'show,',
      'I',
      'want',
      'to',
      'show',
      'you',
    ].map((t, i) => word(i, t));
    expect(findRetakes(words)).toEqual([{ fromIndex: 2, toIndex: 5, text: 'I want to show,' }]);
  });

  it('ignores a single repeated word, and matches across case and punctuation', () => {
    expect(findRetakes(['very', 'very', 'good'].map((t, i) => word(i, t)))).toEqual([]);
    expect(findRetakes(['no', 'no', 'no', 'no'].map((t, i) => word(i, t)))).toEqual([]);
    expect(findRetakes(['very', 'very', 'very', 'very', 'good'].map((t, i) => word(i, t)))).toEqual(
      [],
    );
    expect(findRetakes(['The', 'plan.', 'the', 'plan', 'works'].map((t, i) => word(i, t)))).toEqual(
      [{ fromIndex: 0, toIndex: 1, text: 'The plan.' }],
    );
  });

  it('keeps the transcript index of each word', () => {
    const words = [word(40, 'go'), word(41, 'now'), word(42, 'go'), word(43, 'now')];
    expect(findRetakes(words)).toEqual([{ fromIndex: 40, toIndex: 41, text: 'go now' }]);
  });
});

describe('planWordCut', () => {
  const t = transcript([
    { text: 'So,', startSec: 0, endSec: 0.4 },
    { text: 'today', startSec: 0.4, endSec: 0.8 },
    { text: 'I', startSec: 0.8, endSec: 1 },
    { text: 'want', startSec: 1, endSec: 1.4 },
    { text: 'more', startSec: 1.4, endSec: 2 },
  ]);
  const MEDIA = new Map<MediaId, MediaInfo>([[M, { path: '/ws/talk.mp4', hasAudio: true }]]);
  const clip = mediaClip({ id: 'c', mediaId: M, sourceOutSec: 2, startSec: 0 });
  let n = 0;
  const mint = () => `n${++n}`;
  const plan = (c: typeof clip, ranges: { fromIndex: number; toIndex: number }[]) =>
    planWordCut(
      applyOps(emptyComposition(), [
        { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
        { op: 'addClip', trackId: 'v0', clip: c },
      ]),
      c,
      t,
      ranges,
      { media: MEDIA, mintId: mint },
    );

  it('keeps the rest of the clip around the cut words', () => {
    expect(plan(clip, [{ fromIndex: 2, toIndex: 3 }])).toEqual({
      op: 'silenceCut',
      clipId: 'c',
      keepRegions: [
        { sourceInSec: 0, sourceOutSec: 0.8 },
        { sourceInSec: 1.4, sourceOutSec: 2 },
      ],
      newClipIds: ['n1'],
    });
  });

  it('merges overlapping ranges and clips them to the clip window', () => {
    const trimmed = { ...clip, sourceInSec: 0.4 };
    const ranges = [
      { fromIndex: 0, toIndex: 1 },
      { fromIndex: 1, toIndex: 2 },
    ];
    expect(plan(trimmed, ranges)).toMatchObject({
      keepRegions: [{ sourceInSec: 1, sourceOutSec: 2 }],
      newClipIds: [],
    });
  });

  it('returns null for words outside the clip, and refuses to cut everything', () => {
    const early = { ...clip, sourceInSec: 1.4 };
    expect(plan(early, [{ fromIndex: 0, toIndex: 1 }])).toBeNull();
    expect(() => plan(clip, [{ fromIndex: 0, toIndex: 4 }])).toThrow(/remove the clip/);
    expect(() => plan(clip, [{ fromIndex: 3, toIndex: 9 }])).toThrow(TranscriptError);
  });

  it('refuses a cut that leaves the clip shorter than its incoming transition', () => {
    const after = { ...clip, startSec: 2 };
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M, sourceOutSec: 2, startSec: 0 }),
      },
      { op: 'addClip', trackId: 'v0', clip: after },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'a', kind: 'fade', durationSec: 0.5 },
      },
    ]);
    const cut = (fromIndex: number, toIndex: number) =>
      planWordCut(comp, after, t, [{ fromIndex, toIndex }], { media: MEDIA, mintId: mint });
    expect(() => cut(1, 4)).toThrow(/stop the timeline from exporting/);
    expect(cut(3, 3)).toMatchObject({ op: 'silenceCut', clipId: 'c' });
  });
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

  // The fake source fails audio extraction: one shared run fails once, so both
  // callers see the same error; the next call after it starts a new run.
  it('shares one run between concurrent requests for the same transcription', async () => {
    const { info } = await setup();
    const [a, b] = await Promise.allSettled([transcribeMedia(M, info), transcribeMedia(M, info)]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    const reason = (r: PromiseSettledResult<unknown>) =>
      r.status === 'rejected' ? r.reason : undefined;
    expect(reason(b)).toBe(reason(a));
    const [c] = await Promise.allSettled([transcribeMedia(M, info)]);
    expect(reason(c)).toBeInstanceOf(Error);
    expect(reason(c)).not.toBe(reason(a));
  });

  it('edits against the stored transcript whatever made it, and only that one', async () => {
    const { info, model } = await setup();
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c', mediaId: M, sourceOutSec: 1, startSec: 0 }),
      },
    ]);
    const media = new Map([[M, info]]);
    await expect(storedTranscriptForClip(comp, 'c', media)).rejects.toThrow(/no transcript yet/);

    // Made with a forced language and no model configured now: still the one used.
    const stored = await store(info, model, 'de');
    delete process.env.MAKEMYCLIP_WHISPER_MODEL;
    await expect(storedTranscriptForClip(comp, 'c', media)).resolves.toMatchObject({
      transcript: stored,
    });
    await expect(
      storedTranscriptForClip(comp, 'c', media, transcriptIdOf(stored)),
    ).resolves.toMatchObject({ transcript: stored });
    // Words read from an earlier transcript of the same file are refused.
    await expect(storedTranscriptForClip(comp, 'c', media, 'feedfacecafe')).rejects.toThrow(
      /transcribed again/,
    );

    await writeFile(info.path, 'edited video bytes');
    await expect(storedTranscriptForClip(comp, 'c', media)).rejects.toThrow(/source changed/);
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
