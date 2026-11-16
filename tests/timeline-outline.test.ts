import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '../src/timeline/compile.js';
import { type Composition, emptyComposition, type MediaClip } from '../src/timeline/composition.js';
import {
  applyOps,
  type CompositionOp,
  mediaClip,
  textClip,
  videoTrack,
} from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import {
  clipWords,
  type OutlineWord,
  outlineSentences,
  type Transcript,
  TranscriptError,
  timelineOutline,
} from '../src/timeline/transcript.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;
const N = 'm_bbbbbbbbbbbb' as MediaId;
const O = 'm_cccccccccccc' as MediaId;
const MEDIA = new Map<MediaId, MediaInfo>([
  [M, { path: '/talk.mp4', hasAudio: true }],
  [N, { path: '/broll.mp4', hasAudio: false }],
  [O, { path: '/guest.mp4', hasAudio: true }],
]);

function transcriptOf(mediaId: MediaId, words: Transcript['words']): Transcript {
  return {
    version: 1,
    mediaId,
    language: 'en',
    source: 'whisper-cpp',
    model: 'ggml-base.en.bin',
    modelKey: 'fixture',
    requestedLanguage: 'auto',
    sourceSize: 0,
    sourceMtimeMs: 0,
    words,
  };
}

/** Abutting words, as whisper.cpp gives them: 0.4 s each from 0. */
function spoken(texts: string[]): Transcript['words'] {
  return texts.map((text, i) => ({
    text,
    startSec: Math.round(i * 0.4 * 1000) / 1000,
    endSec: Math.round((i + 1) * 0.4 * 1000) / 1000,
  }));
}

function timelineOf(clips: MediaClip[]): Composition {
  return applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    ...clips.map((clip): CompositionOp => ({ op: 'addClip', trackId: 'v0', clip })),
  ]);
}

const transcribeFrom =
  (...transcripts: Transcript[]) =>
  async (mediaId: MediaId): Promise<Transcript> => {
    const found = transcripts.find((t) => t.mediaId === mediaId);
    if (!found) throw new TranscriptError(`no transcript for ${mediaId}`);
    return found;
  };

const ms = (sec: number): number => Math.round(sec * 1000) / 1000;
const word = (index: number, text: string, startSec: number, endSec: number): OutlineWord => ({
  index,
  text,
  startSec: ms(startSec),
  endSec: ms(endSec),
  clipId: 'c1',
});

describe('outlineSentences', () => {
  it('ends a sentence at its punctuation', () => {
    const words = ['Hello', 'there.', 'How', 'are', 'you?', 'Fine'].map((t, i) =>
      word(i, t, i * 0.4, (i + 1) * 0.4),
    );
    expect(outlineSentences(words)).toEqual([
      { startSec: 0, endSec: 0.8, clipId: 'c1', fromIndex: 0, toIndex: 1, text: 'Hello there.' },
      { startSec: 0.8, endSec: 2, clipId: 'c1', fromIndex: 2, toIndex: 4, text: 'How are you?' },
      { startSec: 2, endSec: 2.4, clipId: 'c1', fromIndex: 5, toIndex: 5, text: 'Fine' },
    ]);
  });

  it('ends one at a long pause, after 40 words, and where the source goes back', () => {
    const paused = [word(0, 'so', 0, 0.3), word(1, 'anyway', 1.2, 1.5)];
    expect(outlineSentences(paused).map((s) => s.text)).toEqual(['so', 'anyway']);

    const run = Array.from({ length: 45 }, (_, i) => word(i, 'and', i * 0.3, (i + 1) * 0.3));
    expect(outlineSentences(run).map((s) => [s.fromIndex, s.toIndex])).toEqual([
      [0, 39],
      [40, 44],
    ]);

    const reordered = [word(10, 'later', 0, 0.4), word(2, 'earlier', 0.4, 0.8)];
    expect(outlineSentences(reordered)).toHaveLength(2);
  });
});

describe('timelineOutline', () => {
  const talk = transcriptOf(
    M,
    spoken(['First', 'point', 'here.', 'Second', 'point', 'runs', 'on', 'long.', 'Third', 'one.']),
  );

  it('keeps word indices across silence-cut sub-clips, listing a split word once', async () => {
    // Cuts at 1.0–1.1 (through "here.", 0.8–1.2) and 2.7–3.0 (before "long.", 2.8–3.2).
    const comp = timelineOf([
      mediaClip({ id: 'c1', mediaId: M, sourceInSec: 0, sourceOutSec: 1, startSec: 0 }),
      mediaClip({ id: 'c2', mediaId: M, sourceInSec: 1.1, sourceOutSec: 2.7, startSec: 1 }),
      mediaClip({ id: 'c3', mediaId: M, sourceInSec: 3, sourceOutSec: 4, startSec: 2.6 }),
    ]);
    const outline = await timelineOutline(comp, MEDIA, { transcribe: transcribeFrom(talk) });
    expect(outline.sentences).toEqual([
      {
        startSec: 0,
        endSec: 1.1,
        clipId: 'c1',
        fromIndex: 0,
        toIndex: 2,
        text: 'First point here.',
      },
      {
        startSec: 1.1,
        endSec: 2.8,
        clipId: 'c2',
        fromIndex: 3,
        toIndex: 7,
        text: 'Second point runs on long.',
      },
      { startSec: 2.8, endSec: 3.6, clipId: 'c3', fromIndex: 8, toIndex: 9, text: 'Third one.' },
    ]);
    // The same indices and times clipWords gives each clip.
    const placed = comp.tracks[0]?.clips.flatMap((c) =>
      c.kind === 'media' ? clipWords(talk, c) : [],
    );
    for (const s of outline.sentences) {
      expect(placed?.find((w) => w.index === s.fromIndex)?.startSec).toBe(s.startSec);
      expect(placed?.findLast((w) => w.index === s.toIndex)?.endSec).toBe(s.endSec);
    }
    expect(Object.keys(outline.transcriptIds)).toEqual([M]);
    expect(outline.sentences.some((s) => 'mediaId' in s)).toBe(false);
    expect(outline.nextFromSec).toBeUndefined();
  });

  it('ends a sentence where the timeline skips words it plays elsewhere', async () => {
    const run = transcriptOf(M, spoken('a b c d e f g h i j k l'.split(' ')));
    // Words 0–1, then 10–11, then 2–9: clips moved out of source order.
    const moved = timelineOf([
      mediaClip({ id: 'c1', mediaId: M, sourceInSec: 0, sourceOutSec: 0.8, startSec: 0 }),
      mediaClip({ id: 'c2', mediaId: M, sourceInSec: 4, sourceOutSec: 4.8, startSec: 0.8 }),
      mediaClip({ id: 'c3', mediaId: M, sourceInSec: 0.8, sourceOutSec: 4, startSec: 1.6 }),
    ]);
    const outline = await timelineOutline(moved, MEDIA, { transcribe: transcribeFrom(run) });
    expect(outline.sentences.map((s) => [s.clipId, s.fromIndex, s.toIndex])).toEqual([
      ['c1', 0, 1],
      ['c2', 10, 11],
      ['c3', 2, 9],
    ]);
  });

  it('keeps a word the timeline plays twice as two, where a clip replays the source', async () => {
    const hello = transcriptOf(M, spoken(['Hello.', 'and', 'so']));
    const transcribe = transcribeFrom(hello);
    const twice = timelineOf([
      mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 0.4, startSec: 0 }),
      mediaClip({ id: 'c2', mediaId: M, sourceOutSec: 0.4, startSec: 0.4 }),
    ]);
    expect(
      (await timelineOutline(twice, MEDIA, { transcribe })).sentences.map((s) => [
        s.clipId,
        s.startSec,
        s.endSec,
      ]),
    ).toEqual([
      ['c1', 0, 0.4],
      ['c2', 0.4, 0.8],
    ]);

    const andAgain = timelineOf([
      mediaClip({ id: 'c1', mediaId: M, sourceInSec: 0.4, sourceOutSec: 0.8, startSec: 0 }),
      mediaClip({ id: 'c2', mediaId: M, sourceInSec: 0.4, sourceOutSec: 1.2, startSec: 0.4 }),
    ]);
    expect(
      (await timelineOutline(andAgain, MEDIA, { transcribe })).sentences.map((s) => s.text),
    ).toEqual(['and', 'and so']);
  });

  it('reads each source once, skips one without sound, and breaks sentences between sources', async () => {
    const guest = transcriptOf(O, spoken(['Hello', 'world']));
    const calls: MediaId[] = [];
    const comp = timelineOf([
      mediaClip({ id: 'c1', mediaId: M, sourceInSec: 0, sourceOutSec: 0.8, startSec: 0 }),
      mediaClip({ id: 'o1', mediaId: O, sourceOutSec: 0.8, startSec: 0.8 }),
      mediaClip({ id: 'b1', mediaId: N, sourceOutSec: 2, startSec: 1.6 }),
      mediaClip({ id: 'c2', mediaId: M, sourceInSec: 1.2, sourceOutSec: 2, startSec: 3.6 }),
    ]);
    const outline = await timelineOutline(comp, MEDIA, {
      transcribe: async (mediaId) => {
        calls.push(mediaId);
        return mediaId === O ? guest : talk;
      },
    });
    expect(calls).toEqual([M, O]);
    expect(outline.sentences.map((s) => [s.clipId, s.fromIndex, s.toIndex, s.text])).toEqual([
      ['c1', 0, 1, 'First point'],
      ['o1', 0, 1, 'Hello world'],
      ['c2', 3, 4, 'Second point'],
    ]);
    expect(Object.keys(outline.transcriptIds)).toEqual([M, O]);
    // Two sources: each sentence names its own, to find its transcriptId.
    expect(outline.sentences.map((s) => s.mediaId)).toEqual([M, O, M]);
  });

  it('pages by size and range, so pages put back together give every sentence once', async () => {
    const comp = timelineOf([mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 4, startSec: 0 })]);
    const transcribe = transcribeFrom(talk);
    const all = (await timelineOutline(comp, MEDIA, { transcribe })).sentences;

    const pages: string[] = [];
    const seen = [];
    let fromSec: number | undefined = 0;
    while (fromSec !== undefined) {
      const page = await timelineOutline(comp, MEDIA, { transcribe, fromSec, maxBytes: 250 });
      pages.push(JSON.stringify(page));
      seen.push(...page.sentences);
      fromSec = page.nextFromSec;
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(Buffer.byteLength(page)).toBeLessThanOrEqual(250);
    expect(seen).toEqual(all);

    const middle = await timelineOutline(comp, MEDIA, { transcribe, fromSec: 1, toSec: 3 });
    expect(middle.sentences.map((s) => s.fromIndex)).toEqual([3]);
  });

  it('keeps sentences that start together on one page, so paging always moves on', async () => {
    // Four one-word sentences at the same instant (zero-length words), then two more.
    const tied = transcriptOf(M, [
      { text: 'Lead.', startSec: 0, endSec: 0.4 },
      ...['A.', 'B.', 'C.', 'D.'].map((text) => ({ text, startSec: 1, endSec: 1 })),
      { text: 'After.', startSec: 1.2, endSec: 1.6 },
      { text: 'End.', startSec: 1.6, endSec: 2 },
    ]);
    const comp = timelineOf([mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 2, startSec: 0 })]);
    const transcribe = transcribeFrom(tied);
    const all = (await timelineOutline(comp, MEDIA, { transcribe })).sentences;
    for (const maxBytes of [300, 450]) {
      const seen = [];
      const starts: number[] = [];
      let fromSec: number | undefined = 0;
      while (fromSec !== undefined) {
        starts.push(fromSec);
        const page = await timelineOutline(comp, MEDIA, { transcribe, fromSec, maxBytes });
        seen.push(...page.sentences);
        fromSec = page.nextFromSec;
        expect(starts.length).toBeLessThan(10);
      }
      expect(seen, `maxBytes ${maxBytes}`).toEqual(all);
      expect(new Set(starts).size).toBe(starts.length);
    }
  });

  it('pages a 60-minute, 9,000-word recording at 40 KB', async () => {
    const texts = Array.from({ length: 9000 }, (_, i) =>
      i % 14 === 13 ? `sentence${i}.` : `word${i}`,
    );
    const hour = transcriptOf(M, spoken(texts));
    const comp = timelineOf([mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 3600, startSec: 0 })]);
    const transcribe = transcribeFrom(hour);

    let count = 0;
    let pages = 0;
    let fromSec: number | undefined = 0;
    while (fromSec !== undefined) {
      const page = await timelineOutline(comp, MEDIA, { transcribe, fromSec });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(40_000);
      count += page.sentences.length;
      pages++;
      fromSec = page.nextFromSec;
    }
    expect(count).toBe(Math.ceil(9000 / 14));
    expect(pages).toBeGreaterThan(1);
  });

  it("outlines one clip, and says why a clip that isn't media can't be", async () => {
    const comp = applyOps(
      timelineOf([
        mediaClip({ id: 'c1', mediaId: M, sourceInSec: 0, sourceOutSec: 1, startSec: 0 }),
        mediaClip({ id: 'c2', mediaId: M, sourceInSec: 1.2, sourceOutSec: 4, startSec: 1 }),
      ]),
      [
        { op: 'addTrack', track: videoTrack({ id: 'captions' }) },
        {
          op: 'addClip',
          trackId: 'captions',
          clip: textClip({ id: 't1', text: 'hi', startSec: 0, durationSec: 1 }),
        },
      ],
    );
    const transcribe = transcribeFrom(talk);
    const one = await timelineOutline(comp, MEDIA, { transcribe, clipId: 'c1' });
    expect(one.sentences.map((s) => s.clipId)).toEqual(['c1']);
    // A clip off the picture track (here a second media track) is still outlined.
    const twoTracks = applyOps(comp, [
      { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
      {
        op: 'addClip',
        trackId: 'v1',
        clip: mediaClip({ id: 'x1', mediaId: M, sourceInSec: 1.2, sourceOutSec: 2, startSec: 0 }),
      },
    ]);
    const off = await timelineOutline(twoTracks, MEDIA, { transcribe, clipId: 'x1' });
    expect(off.sentences.map((s) => [s.clipId, s.fromIndex, s.toIndex])).toEqual([['x1', 3, 4]]);
    await expect(timelineOutline(comp, MEDIA, { transcribe, clipId: 't1' })).rejects.toThrow(
      /text clip/,
    );
  });
});
