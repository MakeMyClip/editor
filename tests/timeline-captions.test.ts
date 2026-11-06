import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CaptionError,
  groupCaptions,
  joinWords,
  planCaptions,
  type TranscriptLookup,
} from '../src/timeline/captions.js';
import { checkExportable } from '../src/timeline/compile.js';
import { type Composition, emptyComposition, findClip } from '../src/timeline/composition.js';
import {
  applyVerbs,
  readComposition,
  undoLastDocOp,
  writeComposition,
} from '../src/timeline/document-store.js';
import { applyOps, colorClip, mediaClip, videoTrack } from '../src/timeline/ops.js';
import { hardCuts } from '../src/timeline/review.js';
import type { MediaId } from '../src/timeline/schema.js';
import {
  type ClipWord,
  NoTranscriptError,
  planWordCut,
  type Transcript,
  TranscriptError,
} from '../src/timeline/transcript.js';
import { lowerVerb, type VerbContext } from '../src/timeline/verbs.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;
const N = 'm_bbbbbbbbbbbb' as MediaId;

/** Words spoken back to back, 0.4 s each, from `startSec`. */
function spoken(text: string, startSec = 0): ClipWord[] {
  return text.split(' ').map((t, index) => ({
    index,
    text: t,
    startSec: Math.round((startSec + index * 0.4) * 1000) / 1000,
    endSec: Math.round((startSec + index * 0.4 + 0.35) * 1000) / 1000,
  }));
}

function transcriptOf(mediaId: MediaId, words: ClipWord[]): Transcript {
  return {
    version: 1,
    mediaId,
    language: 'en',
    source: 'whisper-cpp',
    model: 'ggml-tiny.en.bin',
    modelKey: '',
    requestedLanguage: 'auto',
    sourceSize: 0,
    sourceMtimeMs: 0,
    words: words.map(({ text, startSec, endSec }) => ({ text, startSec, endSec })),
  };
}

describe('groupCaptions', () => {
  it('breaks phrases at the word limit and after a sentence ends', () => {
    const words = spoken('a b c d e f g h. i j');
    const cues = groupCaptions(words, 10, 7);
    expect(cues.map((c) => c.text)).toEqual(['a b c d e f g', 'h.', 'i j']);
  });

  it('shows one word at a time with maxWords 1, holding each until the next', () => {
    const cues = groupCaptions(spoken('hello big world'), 10, 1);
    expect(cues).toEqual([
      { text: 'hello', startSec: 0, endSec: 0.4 },
      { text: 'big', startSec: 0.4, endSec: 0.8 },
      // The last holds 0.4 s past its word.
      { text: 'world', startSec: 0.8, endSec: 1.55 },
    ]);
  });

  it('starts a new caption after a pause and never runs past the clip end', () => {
    const words = [...spoken('before the pause'), ...spoken('after it', 3)];
    const cues = groupCaptions(words, 3.6, 7);
    expect(cues.map((c) => c.text)).toEqual(['before the pause', 'after it']);
    expect(cues[1]?.endSec).toBe(3.6);
  });

  it('keeps captions within the width limit, counting CJK characters as wide', () => {
    const long = spoken('internationalization considerations everywhere');
    expect(groupCaptions(long, 10, 7).map((c) => c.text)).toEqual([
      'internationalization',
      'considerations everywhere',
    ]);
    const han = '一 二 三 四 五 六 七 八 九 十 十 一 二 三 四 五 六 七'.split(' ');
    const cues = groupCaptions(spoken(han.join(' ')), 20, 12);
    expect(cues.every((c) => [...c.text].length <= 16)).toBe(true);
  });

  it('ends a caption on or before a clip end that falls between milliseconds', () => {
    const cues = groupCaptions(spoken('last word', 3.5), 4.066667, 7);
    expect(cues.at(-1)?.endSec).toBe(4.066);
  });

  it('gives a zero-length word a short caption instead of dropping it', () => {
    const cues = groupCaptions([{ index: 0, text: 'hm', startSec: 1, endSec: 1 }], 5, 7);
    expect(cues).toEqual([{ text: 'hm', startSec: 1, endSec: 1.4 }]);
  });
});

describe('joinWords', () => {
  it('spaces Latin and Cyrillic words, glues Chinese and Japanese, and closes punctuation', () => {
    expect(joinWords(['Привет', 'мир'])).toBe('Привет мир');
    expect(joinWords(['你', '好', '世界', '。'])).toBe('你好世界。');
    expect(joinWords(['こんにちは', '世界'])).toBe('こんにちは世界');
    expect(joinWords(['Hello', ',', 'world', '!'])).toBe('Hello, world!');
  });
});

/** v0 holds two clips cut from one recording (as silence removal leaves them). */
function cutRecording(): Composition {
  return applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'a', mediaId: M, sourceInSec: 0, sourceOutSec: 2, startSec: 0 }),
    },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'b', mediaId: M, sourceInSec: 4, sourceOutSec: 6, startSec: 2 }),
    },
  ]);
}

const RECORDING = transcriptOf(M, [
  ...spoken('first part of it'),
  ...spoken('second part here', 4.2),
]);

function lookup(transcripts: Map<MediaId, Transcript>, calls: string[] = []): TranscriptLookup {
  return async (clipId) => {
    calls.push(clipId);
    const found = findClip(currentDoc, clipId);
    if (found?.clip.kind !== 'media') throw new TranscriptError(`No clip "${clipId}"`);
    const transcript = transcripts.get(found.clip.mediaId);
    if (!transcript) throw new NoTranscriptError(`Clip "${clipId}" has no transcript yet.`);
    return { clip: found.clip, transcript };
  };
}
let currentDoc: Composition = emptyComposition();

function counter(prefix = 'cap'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

describe('planCaptions', () => {
  it('captions every clip of a recording on a new track above it, read once per source', async () => {
    currentDoc = cutRecording();
    const calls: string[] = [];
    const plan = await planCaptions(
      currentDoc,
      {},
      lookup(new Map([[M, RECORDING]]), calls),
      counter(),
    );
    expect(calls).toEqual(['a']);
    expect(plan).toMatchObject({ captions: 2, clipIds: ['a', 'b'], track: 'captions' });
    const doc = applyOps(currentDoc, plan.ops);
    expect(doc.tracks.map((t) => t.id)).toEqual(['v0', 'captions']);
    const captions = doc.tracks[1]?.clips ?? [];
    expect(captions.map((c) => (c.kind === 'text' ? c.text : ''))).toEqual([
      'first part of it',
      'second part here',
    ]);
    // Clip b plays source 4–6 from timeline 2, so its words land at 2.2+.
    expect(captions[1]?.startSec).toBe(2.2);
    expect(captions[0]).toMatchObject({
      style: { anchor: 'bottom-center', fontSize: 54, color: 'white', background: 'black@0.6' },
    });
    expect(checkExportable(doc, new Map([[M, { path: '/a.mp4', hasAudio: true }]]), '.')).toEqual({
      exportable: true,
      blockers: [],
    });
    // Caption joins aren't cuts.
    expect(hardCuts(doc).map((c) => c.trackId)).toEqual(['v0']);
  });

  it('replaces the whole caption track, or only the captions over one clip', async () => {
    currentDoc = cutRecording();
    const transcripts = new Map([[M, RECORDING]]);
    currentDoc = applyOps(
      currentDoc,
      (await planCaptions(currentDoc, {}, lookup(transcripts), counter())).ops,
    );

    const again = await planCaptions(
      currentDoc,
      { maxWords: 1 },
      lookup(transcripts),
      counter('again'),
    );
    expect(again.ops.filter((o) => o.op === 'removeClip')).toHaveLength(2);
    expect(again.captions).toBe(7);

    const one = await planCaptions(
      currentDoc,
      { clipId: 'b', maxWords: 1, style: { anchor: 'top-center' } },
      lookup(transcripts),
      counter('one'),
    );
    const doc = applyOps(currentDoc, one.ops);
    const texts = (doc.tracks[1]?.clips ?? []).map((c) => (c.kind === 'text' ? c.text : ''));
    expect(texts).toEqual(['first part of it', 'second', 'part', 'here']);
  });

  it('skips sources with no transcript, and says so when none has one', async () => {
    currentDoc = applyOps(cutRecording(), [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c', mediaId: N, sourceOutSec: 1, startSec: 4 }),
      },
    ]);
    const plan = await planCaptions(currentDoc, {}, lookup(new Map([[M, RECORDING]])), counter());
    expect(plan.clipIds).toEqual(['a', 'b']);
    await expect(planCaptions(currentDoc, {}, lookup(new Map()), counter())).rejects.toThrow(
      CaptionError,
    );
    await expect(
      planCaptions(currentDoc, { clipId: 'c' }, lookup(new Map()), counter()),
    ).rejects.toThrow(/no transcript yet/);
  });

  it('leaves a later word cut free to run before the captions are made again', async () => {
    currentDoc = cutRecording();
    const transcripts = new Map([[M, RECORDING]]);
    currentDoc = applyOps(
      currentDoc,
      (await planCaptions(currentDoc, {}, lookup(transcripts), counter())).ops,
    );
    const b = findClip(currentDoc, 'b')?.clip;
    if (b?.kind !== 'media') throw new Error('expected clip b');
    const media = new Map([[M, { path: '/a.mp4', hasAudio: true }]]);
    // "here" ends clip b's speech; cutting it pulls the picture's end in under
    // the caption that held it.
    const op = planWordCut(currentDoc, b, RECORDING, [{ fromIndex: 6, toIndex: 6 }], { media });
    const after = applyOps(currentDoc, op ? [op] : []);
    expect(checkExportable(after, media, '.').blockers.join(' ')).toMatch(
      /make the captions again/,
    );
  });

  it('replaces the captions a trim left past the clip when captioning it again', async () => {
    currentDoc = applyOps(cutRecording(), [{ op: 'removeClip', clipId: 'b' }]);
    const long = transcriptOf(M, spoken('one two three four five six seven eight nine ten'));
    const transcripts = new Map([[M, long]]);
    currentDoc = applyOps(
      currentDoc,
      (await planCaptions(currentDoc, { maxWords: 2 }, lookup(transcripts), counter())).ops,
    );
    currentDoc = applyOps(currentDoc, [{ op: 'setTrim', clipId: 'a', sourceOutSec: 1 }]);
    const again = await planCaptions(
      currentDoc,
      { clipId: 'a', maxWords: 2 },
      lookup(transcripts),
      counter('again'),
    );
    const doc = applyOps(currentDoc, again.ops);
    const captions = doc.tracks.find((t) => t.id === 'captions')?.clips ?? [];
    expect(captions.every((c) => c.id.startsWith('again'))).toBe(true);
    expect(checkExportable(doc, new Map([[M, { path: '/a.mp4', hasAudio: true }]]), '.')).toEqual({
      exportable: true,
      blockers: [],
    });
  });

  it('lifts a caption track left under the picture back on top', async () => {
    currentDoc = applyOps(cutRecording(), [
      { op: 'addTrack', track: videoTrack({ id: 'captions' }), index: 0 },
    ]);
    const plan = await planCaptions(currentDoc, {}, lookup(new Map([[M, RECORDING]])), counter());
    const doc = applyOps(currentDoc, plan.ops);
    expect(doc.tracks.map((t) => t.id)).toEqual(['v0', 'captions']);
    expect(doc.tracks[1]?.clips).toHaveLength(2);
    expect(
      checkExportable(doc, new Map([[M, { path: '/a.mp4', hasAudio: true }]]), '.').exportable,
    ).toBe(true);
  });

  it('refuses a caption track that holds video', async () => {
    currentDoc = applyOps(cutRecording(), [
      { op: 'addTrack', track: videoTrack({ id: 'captions' }) },
      {
        op: 'addClip',
        trackId: 'captions',
        clip: colorClip({ id: 'k', durationSec: 1, startSec: 0 }),
      },
    ]);
    await expect(
      planCaptions(currentDoc, {}, lookup(new Map([[M, RECORDING]])), counter()),
    ).rejects.toThrow(/captions need a track of their own/);
  });

  it('plans nothing when there is nothing to say and nothing to replace', async () => {
    currentDoc = cutRecording();
    const silent = transcriptOf(M, []);
    const plan = await planCaptions(currentDoc, {}, lookup(new Map([[M, silent]])), counter());
    expect(plan.ops).toEqual([]);
  });
});

describe('caption_speech verb', () => {
  const verbCtx = (): VerbContext => ({
    ingest: async () => {
      throw new Error('not used');
    },
    analyzeSilence: async () => {
      throw new Error('not used');
    },
    transcript: async (comp, clipId, transcriptId) => {
      currentDoc = comp;
      if (transcriptId === 'stale') throw new TranscriptError('transcribed again');
      const { clip, transcript } = await lookup(new Map([[M, RECORDING]]))(clipId);
      return { clip, transcript, media: new Map() };
    },
    defaultTrack: 'v0',
  });

  it('lowers style options onto the caption clips', async () => {
    const ops = await lowerVerb(
      cutRecording(),
      { verb: 'caption_speech', clipId: 'a', color: 'yellow', background: null, fontSize: 40 },
      verbCtx(),
    );
    expect(ops[0]).toMatchObject({ op: 'addTrack', track: { id: 'captions' } });
    expect(ops[1]).toMatchObject({
      op: 'addClip',
      trackId: 'captions',
      clip: { kind: 'text', style: { color: 'yellow', background: null, fontSize: 40 } },
    });
  });

  it('passes the transcriptId through so a changed transcript is refused', async () => {
    await expect(
      lowerVerb(
        cutRecording(),
        { verb: 'caption_speech', clipId: 'a', transcriptId: 'stale' },
        verbCtx(),
      ),
    ).rejects.toThrow(/transcribed again/);
  });

  describe('as one undoable edit', () => {
    let workspace: string;
    let saved: string | undefined;
    beforeEach(async () => {
      workspace = await mkdtemp(join(tmpdir(), 'mmc-captions-'));
      saved = process.env.MAKEMYCLIP_WORKSPACE;
      process.env.MAKEMYCLIP_WORKSPACE = workspace;
    });
    afterEach(async () => {
      if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
      else process.env.MAKEMYCLIP_WORKSPACE = saved;
      await rm(workspace, { recursive: true, force: true });
    });

    it('adds the track and captions in one step that one undo takes back', async () => {
      await writeComposition(cutRecording());
      const { doc } = await applyVerbs([{ verb: 'caption_speech' }], verbCtx());
      expect(doc.tracks.find((t) => t.id === 'captions')?.clips).toHaveLength(2);
      await undoLastDocOp();
      expect((await readComposition()).tracks.map((t) => t.id)).toEqual(['v0']);
    });
  });
});
