import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Composition,
  emptyComposition,
  findClip,
  type MediaClip,
} from '../src/timeline/composition.js';
import {
  applyVerbs,
  NoTimelineError,
  readComposition,
  readDocOpLog,
  resetComposition,
  undoLastDocOp,
} from '../src/timeline/document-store.js';
import {
  applyOps,
  type CompositionOp,
  mediaClip,
  textClip,
  videoTrack,
} from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import {
  checkShortTimelines,
  planShort,
  ShortError,
  type ShortRequest,
  type ShortTranscriptLookup,
} from '../src/timeline/shorts.js';
import { NoTranscriptError, type Transcript, TranscriptError } from '../src/timeline/transcript.js';
import { EditableVerbSchema, lowerVerb, type VerbContext } from '../src/timeline/verbs.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;
const N = 'm_bbbbbbbbbbbb' as MediaId;

function transcriptOf(mediaId: MediaId, spans: [number, number][]): Transcript {
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
    words: spans.map(([startSec, endSec], i) => ({ text: `w${i}`, startSec, endSec })),
  };
}

/** Word i spoken from i+1 s to i+1.5 s: half-second pauses between words. */
const SPACED = transcriptOf(
  M,
  Array.from({ length: 20 }, (_, i): [number, number] => [i + 1, i + 1.5]),
);

/** A recording on the source timeline's picture track. */
function sourceOf(clips: MediaClip[], canvas: Partial<Composition> = {}): Composition {
  return applyOps(emptyComposition({ width: 1920, height: 1080, ...canvas }), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    ...clips.map((clip): CompositionOp => ({ op: 'addClip', trackId: 'v0', clip })),
  ]);
}

const clipOf = (
  id: string,
  sourceInSec: number,
  sourceOutSec: number,
  startSec: number,
  extra: Partial<MediaClip> = {},
): MediaClip =>
  mediaClip({ id, mediaId: M, sourceInSec, sourceOutSec, startSec, effects: extra.effects });

function lookupFor(transcripts: Transcript[]): ShortTranscriptLookup {
  return async (comp, clipId) => {
    const found = findClip(comp, clipId);
    if (found?.clip.kind !== 'media') throw new TranscriptError(`No clip "${clipId}"`);
    const transcript = transcripts.find((t) => t.mediaId === found.clip.mediaId);
    if (!transcript) throw new NoTranscriptError(`Clip "${clipId}" has no transcript yet.`);
    return { clip: found.clip as MediaClip, transcript };
  };
}

function counter(prefix = 's'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

async function plan(
  source: Composition,
  request: ShortRequest,
  opts: { target?: Composition; transcripts?: Transcript[] } = {},
) {
  return planShort(
    opts.target ?? emptyComposition(),
    source,
    { captions: false, ...request },
    lookupFor(opts.transcripts ?? [SPACED]),
    counter(),
  );
}

type AddClipOp = Extract<CompositionOp, { op: 'addClip' }>;
const addedClips = (ops: CompositionOp[]): AddClipOp['clip'][] =>
  ops.filter((o): o is AddClipOp => o.op === 'addClip').map((o) => o.clip);

describe('planShort: edges', () => {
  const whole = sourceOf([clipOf('c1', 0, 30, 0)]);

  it('starts a range 0.25 s before its first word and ends it with its last', async () => {
    const short = await plan(whole, { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }] });
    expect(short.pieces).toEqual([{ mediaId: M, sourceInSec: 2.75, sourceOutSec: 5.5 }]);
    expect(short.durationSec).toBe(2.75);
  });

  it('stops the lead halfway into the word before, and at the start of the file', async () => {
    const tight = transcriptOf(M, [
      [0.03, 0.3],
      [0.32, 0.6],
      [0.65, 0.9],
      [0.95, 1.2],
    ]);
    const middle = await plan(
      whole,
      { ranges: [{ clipId: 'c1', fromIndex: 1, toIndex: 2 }] },
      { transcripts: [tight] },
    );
    expect(middle.pieces).toEqual([{ mediaId: M, sourceInSec: 0.165, sourceOutSec: 0.9 }]);

    const first = await plan(
      whole,
      { ranges: [{ clipId: 'c1', fromIndex: 0, toIndex: 0 }] },
      { transcripts: [tight] },
    );
    expect(first.pieces).toEqual([{ mediaId: M, sourceInSec: 0, sourceOutSec: 0.3 }]);
  });

  it('stops at the end of the source clip', async () => {
    const short = await plan(sourceOf([clipOf('c1', 0, 5.3, 0)]), {
      ranges: [{ clipId: 'c1', fromIndex: 3, toIndex: 4 }],
    });
    expect(short.pieces).toEqual([{ mediaId: M, sourceInSec: 3.75, sourceOutSec: 5.3 }]);
  });

  it('refuses word indices outside the transcript', async () => {
    await expect(
      plan(whole, { ranges: [{ clipId: 'c1', fromIndex: 18, toIndex: 25 }] }),
    ).rejects.toThrow(/aren't in the transcript.*20 words/);
    await expect(
      plan(whole, { ranges: [{ clipId: 'c1', fromIndex: 4, toIndex: 2 }] }),
    ).rejects.toBeInstanceOf(ShortError);
  });
});

describe('planShort: cut from the source timeline', () => {
  it('keeps the silence cuts made on the source: three sub-clips give three pieces', async () => {
    const cut = sourceOf([
      clipOf('c1', 0, 3.7, 0),
      clipOf('c2', 3.9, 5.7, 3.7),
      clipOf('c3', 5.9, 12, 5.5),
    ]);
    const short = await plan(cut, { ranges: [{ clipId: 'c2', fromIndex: 2, toIndex: 6 }] });
    expect(short.pieces).toEqual([
      { mediaId: M, sourceInSec: 2.75, sourceOutSec: 3.7 },
      { mediaId: M, sourceInSec: 3.9, sourceOutSec: 5.7 },
      { mediaId: M, sourceInSec: 5.9, sourceOutSec: 7.5 },
    ]);
    expect(addedClips(short.ops).map((c) => c.startSec)).toEqual([0, 0.95, 2.75]);
    expect(short.durationSec).toBe(4.35);
  });

  it('refuses words that were cut out of the source timeline', async () => {
    const retakeCut = sourceOf([clipOf('c1', 0, 3.7, 0), clipOf('c3', 5.9, 12, 3.7)]);
    await expect(
      plan(retakeCut, { ranges: [{ clipId: 'c1', fromIndex: 3, toIndex: 4 }] }),
    ).rejects.toThrow(/cut out of the source timeline/);
  });

  it('leaves out a sliver that holds only padding', async () => {
    // The lead of word 3 (starts 4.0) reaches back to 3.75, just into the end of c1.
    const cut = sourceOf([clipOf('c1', 0, 3.8, 0), clipOf('c2', 3.85, 12, 3.8)]);
    const short = await plan(cut, { ranges: [{ clipId: 'c2', fromIndex: 3, toIndex: 4 }] });
    expect(short.pieces).toEqual([{ mediaId: M, sourceInSec: 3.85, sourceOutSec: 5.5 }]);
  });

  it('refuses words cut out exactly, where only padding touches them', async () => {
    // Word 2 (3.0–3.5) was cut out exactly: c1 ends at its start, c2 starts at its end.
    const exact = sourceOf([clipOf('c1', 0, 3, 0), clipOf('c2', 3.5, 30, 3)]);
    await expect(
      plan(exact, { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 2 }] }),
    ).rejects.toThrow(/cut out of the source timeline/);
  });

  it('refuses a range whose words were all cut, leaving only the gap between them', async () => {
    const apart = transcriptOf(M, [
      [1, 1.5],
      [4, 4.5],
    ]);
    const gapOnly = sourceOf([clipOf('c1', 1.5, 4, 0)]);
    await expect(
      plan(
        gapOnly,
        { ranges: [{ clipId: 'c1', fromIndex: 0, toIndex: 1 }] },
        { transcripts: [apart] },
      ),
    ).rejects.toThrow(/cut out of the source timeline/);
  });

  it('keeps the lead padding across a split at the first word', async () => {
    const split = sourceOf([clipOf('c1', 0, 3, 0), clipOf('c2', 3, 30, 3)]);
    const short = await plan(split, { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 2 }] });
    expect(short.pieces).toEqual([{ mediaId: M, sourceInSec: 2.75, sourceOutSec: 3.5 }]);
  });

  it('plays two ranges of neighboring words straight through, without replaying padding', async () => {
    const close = transcriptOf(M, [
      [1, 1.5],
      [1.7, 2.2],
      [2.9, 3.4],
    ]);
    const whole = sourceOf([clipOf('c1', 0, 30, 0)]);
    const short = await plan(
      whole,
      {
        ranges: [
          { clipId: 'c1', fromIndex: 0, toIndex: 0 },
          { clipId: 'c1', fromIndex: 1, toIndex: 1 },
        ],
      },
      { transcripts: [close] },
    );
    expect(short.pieces).toEqual([{ mediaId: M, sourceInSec: 0.75, sourceOutSec: 2.2 }]);

    const repeated = await plan(
      whole,
      {
        ranges: [
          { clipId: 'c1', fromIndex: 1, toIndex: 1 },
          { clipId: 'c1', fromIndex: 0, toIndex: 1 },
        ],
      },
      { transcripts: [close] },
    );
    expect(repeated.pieces).toEqual([
      { mediaId: M, sourceInSec: 1.45, sourceOutSec: 2.2 },
      { mediaId: M, sourceInSec: 0.75, sourceOutSec: 2.2 },
    ]);
  });

  it('plays the ranges in the order given', async () => {
    const whole = sourceOf([clipOf('c1', 0, 30, 0)]);
    const short = await plan(whole, {
      ranges: [
        { clipId: 'c1', fromIndex: 6, toIndex: 7 },
        { clipId: 'c1', fromIndex: 1, toIndex: 2 },
      ],
    });
    expect(short.pieces).toEqual([
      { mediaId: M, sourceInSec: 6.75, sourceOutSec: 8.5 },
      { mediaId: M, sourceInSec: 1.75, sourceOutSec: 3.5 },
    ]);
    expect(addedClips(short.ops).map((c) => c.startSec)).toEqual([0, 1.75]);
  });

  it('cuts ranges from two recordings', async () => {
    const other = transcriptOf(N, [[0.5, 1]]);
    const two = sourceOf([
      clipOf('c1', 0, 30, 0),
      mediaClip({ id: 'd1', mediaId: N, sourceOutSec: 2, startSec: 30 }),
    ]);
    const short = await plan(
      two,
      {
        ranges: [
          { clipId: 'd1', fromIndex: 0, toIndex: 0 },
          { clipId: 'c1', fromIndex: 0, toIndex: 0 },
        ],
      },
      { transcripts: [SPACED, other] },
    );
    expect(short.pieces.map((p) => p.mediaId)).toEqual([N, M]);
  });

  it('takes a moment the source plays twice only once', async () => {
    const repeated = sourceOf([clipOf('c1', 0, 10, 0), clipOf('c2', 2, 6, 10)]);
    const short = await plan(repeated, { ranges: [{ clipId: 'c2', fromIndex: 2, toIndex: 4 }] });
    expect(short.pieces).toEqual([{ mediaId: M, sourceInSec: 2.75, sourceOutSec: 5.5 }]);
  });

  it('joins pieces that a split (not a cut) left continuous', async () => {
    const split = sourceOf([clipOf('c1', 0, 4, 0), clipOf('c2', 4, 10, 4)]);
    const short = await plan(split, { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }] });
    expect(short.pieces).toEqual([{ mediaId: M, sourceInSec: 2.75, sourceOutSec: 5.5 }]);
  });

  it('keeps color and volume, and drops the fades of the source clip', async () => {
    const source = sourceOf([
      clipOf('c1', 0, 30, 0, {
        effects: [
          { type: 'fadeIn', durationSec: 1 },
          { type: 'adjust', brightness: 0.1, contrast: 1, saturation: 1 },
          { type: 'volume', gain: 1.5 },
        ],
      }),
    ]);
    const short = await plan(source, { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }] });
    expect(addedClips(short.ops)[0]?.effects.map((e) => e.type)).toEqual(['adjust', 'volume']);
  });

  it('refuses a range over a clip with a speed change', async () => {
    const fast = sourceOf([clipOf('c1', 0, 30, 0, { effects: [{ type: 'speed', factor: 2 }] })]);
    await expect(
      plan(fast, { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }] }),
    ).rejects.toThrow(/2x.*speed/);
  });

  it('refuses a source timeline with no picture track', async () => {
    await expect(
      plan(emptyComposition(), { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }] }),
    ).rejects.toThrow(/no picture track/);
  });
});

describe('planShort: the edit', () => {
  const whole = sourceOf([clipOf('c1', 0, 30, 0)]);

  it('builds a 9:16 cover canvas, the pieces, the framing, -14 LUFS and captions', async () => {
    const short = await planShort(
      emptyComposition(),
      whole,
      { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }], x: 0.3 },
      lookupFor([SPACED]),
      counter(),
    );
    expect(short.ops).toEqual([
      { op: 'setCanvas', width: 1080, height: 1920, fps: 30, background: 'black', fit: 'cover' },
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({
          id: 's1',
          mediaId: M,
          sourceInSec: 2.75,
          sourceOutSec: 5.5,
          startSec: 0,
        }),
      },
      { op: 'setTransform', clipId: 's1', transform: { x: 0.3 } },
      { op: 'setLoudness', targetLufs: -14 },
      { op: 'addTrack', track: videoTrack({ id: 'captions' }) },
      {
        op: 'addClip',
        trackId: 'captions',
        clip: textClip({
          id: 's2',
          text: 'w2 w3 w4',
          startSec: 0.25,
          durationSec: 2.5,
          style: { fontSize: 54, color: 'white', background: 'black@0.6', anchor: 'bottom-center' },
        }),
      },
    ]);
    expect(short.captions).toBe(1);
    expect(short.warnings).toEqual([]);
  });

  it('captions only the asked-for words, not the word the lead reaches into', async () => {
    // whisper.cpp words abut: w0 runs through the pause before w1.
    const abutting = transcriptOf(M, [
      [0, 1],
      [1, 1.5],
      [1.5, 2],
      [2, 3],
    ]);
    const short = await planShort(
      emptyComposition(),
      whole,
      { ranges: [{ clipId: 'c1', fromIndex: 1, toIndex: 2 }] },
      lookupFor([abutting]),
      counter(),
    );
    expect(short.pieces).toEqual([{ mediaId: M, sourceInSec: 0.75, sourceOutSec: 2 }]);
    const captions = addedClips(short.ops).filter((c) => c.kind === 'text');
    expect(captions.map((c) => (c.kind === 'text' ? c.text : ''))).toEqual(['w1 w2']);
  });

  it("captions each piece from its own range, even when another range asks for the lead's word", async () => {
    const abutting = transcriptOf(M, [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    const short = await planShort(
      emptyComposition(),
      whole,
      {
        ranges: [
          { clipId: 'c1', fromIndex: 1, toIndex: 1 },
          { clipId: 'c1', fromIndex: 0, toIndex: 0 },
        ],
      },
      lookupFor([abutting]),
      counter(),
    );
    expect(short.pieces).toEqual([
      { mediaId: M, sourceInSec: 0.75, sourceOutSec: 2 },
      { mediaId: M, sourceInSec: 0, sourceOutSec: 1 },
    ]);
    const captions = addedClips(short.ops).flatMap((c) =>
      c.kind === 'text' ? [{ text: c.text, startSec: c.startSec }] : [],
    );
    expect(captions).toEqual([
      { text: 'w1', startSec: 0.25 },
      { text: 'w0', startSec: 1.25 },
    ]);
  });

  it('keeps the source short side: a 720p source makes 720x1280, 1:1 makes a square', async () => {
    const hd = sourceOf([clipOf('c1', 0, 30, 0)], { width: 1280, height: 720, fps: 25 });
    const range = { clipId: 'c1', fromIndex: 2, toIndex: 4 };
    const vertical = await plan(hd, { ranges: [range] });
    expect(vertical.ops[0]).toMatchObject({ width: 720, height: 1280, fps: 25 });
    const square = await plan(hd, { ranges: [range], aspect: '1:1' });
    expect(square.ops[0]).toMatchObject({ width: 720, height: 720 });
  });

  it('leaves loudness off with null, and captions out when asked', async () => {
    const short = await plan(whole, {
      ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }],
      targetLufs: null,
    });
    expect(short.ops.map((o) => o.op)).toEqual(['setCanvas', 'addTrack', 'addClip']);
    expect(short.captions).toBe(0);
  });

  it('refuses a timeline that already holds a short, and rebuilds it with replace', async () => {
    const range = { clipId: 'c1', fromIndex: 2, toIndex: 4 };
    const first = await plan(whole, { ranges: [range] });
    const made = applyOps(emptyComposition(), first.ops);
    await expect(plan(whole, { ranges: [range] }, { target: made })).rejects.toThrow(/replace/);

    const rebuilt = await plan(whole, { ranges: [range], replace: true }, { target: made });
    // Loudness is already -14, so only the tracks and clips are rebuilt.
    expect(rebuilt.ops.map((o) => o.op)).toEqual([
      'removeTrack',
      'setCanvas',
      'addTrack',
      'addClip',
    ]);
  });

  it('reuses a timeline left empty by an undo without replace', async () => {
    const emptied = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    ]);
    const short = await plan(
      whole,
      { ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }] },
      { target: emptied },
    );
    expect(short.ops[0]).toEqual({ op: 'removeTrack', trackId: 'v0' });
    expect(() => applyOps(emptied, short.ops)).not.toThrow();
  });
});

describe('checkShortTimelines', () => {
  it('refuses main as the short, and the short as its own source', () => {
    expect(() => checkShortTimelines('main')).toThrow(/not main/);
    expect(() => checkShortTimelines('best-1', 'best-1')).toThrow(/its own timeline/);
    expect(() => checkShortTimelines('best-1')).not.toThrow();
    expect(() => checkShortTimelines('best-2', 'best-1')).not.toThrow();
  });
});

describe('make_short verb', () => {
  const whole = sourceOf([clipOf('c1', 0, 30, 0)]);
  const ctxFor = (timeline?: string, sources: Record<string, Composition> = {}): VerbContext => ({
    ingest: async () => {
      throw new Error('not used');
    },
    analyzeSilence: async () => {
      throw new Error('not used');
    },
    transcript: async (comp, clipId, transcriptId) => ({
      ...(await lookupFor([SPACED])(comp, clipId, transcriptId)),
      media: new Map(),
    }),
    readTimeline: async (id) => {
      const doc = sources[id];
      if (!doc) throw new NoTimelineError(id);
      return doc;
    },
    defaultTrack: 'v0',
    timeline,
  });
  const verb = {
    verb: 'make_short' as const,
    ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }],
  };

  it('lowers to the planned short, cut from main by default', async () => {
    const ops = await lowerVerb(emptyComposition(), verb, ctxFor('best-1', { main: whole }));
    const doc = applyOps(emptyComposition(), ops);
    expect(doc).toMatchObject({ width: 1080, height: 1920, fit: 'cover' });
    expect(doc.loudness).toEqual({ targetLufs: -14 });
    expect(doc.tracks.map((t) => t.id)).toEqual(['v0', 'captions']);
  });

  it('cuts from another timeline with source', async () => {
    const ops = await lowerVerb(
      emptyComposition(),
      { ...verb, source: 'long-cut' },
      ctxFor('best-1', { 'long-cut': whole }),
    );
    expect(ops.length).toBeGreaterThan(0);
  });

  it('refuses main as its target', async () => {
    await expect(
      lowerVerb(emptyComposition(), verb, ctxFor(undefined, { main: whole })),
    ).rejects.toBeInstanceOf(ShortError);
  });

  it('is an editable verb with bounded ranges and settings', () => {
    const ok = (extra: Record<string, unknown>): boolean =>
      EditableVerbSchema.safeParse({ ...verb, ...extra }).success;
    expect(ok({})).toBe(true);
    expect(ok({ ranges: [] })).toBe(false);
    expect(ok({ ranges: Array.from({ length: 21 }, () => verb.ranges[0]) })).toBe(false);
    expect(ok({ ranges: [{ clipId: 'c1', fromIndex: -1, toIndex: 2 }] })).toBe(false);
    expect(ok({ x: 1.5 })).toBe(false);
    expect(ok({ maxWords: 13 })).toBe(false);
    expect(ok({ targetLufs: -40 })).toBe(false);
    expect(ok({ targetLufs: null, captions: false, replace: true, aspect: '4:5' })).toBe(true);
    expect(ok({ source: 'Main Cut' })).toBe(false);
  });
});

describe('make_short on the store', () => {
  let workspace: string;
  let saved: string | undefined;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'mmc-shorts-test-'));
    saved = process.env.MAKEMYCLIP_WORKSPACE;
    process.env.MAKEMYCLIP_WORKSPACE = workspace;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
    else process.env.MAKEMYCLIP_WORKSPACE = saved;
    await rm(workspace, { recursive: true, force: true });
  });

  const ctx: VerbContext = {
    ingest: async () => {
      throw new Error('not used');
    },
    analyzeSilence: async () => {
      throw new Error('not used');
    },
    transcript: async (comp, clipId, transcriptId) => ({
      ...(await lookupFor([SPACED])(comp, clipId, transcriptId)),
      media: new Map(),
    }),
    readTimeline: (id) => readComposition(id),
    defaultTrack: 'v0',
  };
  const makeShort = {
    verb: 'make_short' as const,
    ranges: [{ clipId: 'c1', fromIndex: 2, toIndex: 4 }],
  };

  it('creates the short as one undoable edit and leaves main alone', async () => {
    const main = await resetComposition(sourceOf([clipOf('c1', 0, 30, 0)]));

    const { doc } = await applyVerbs([makeShort], ctx, 'best-1');
    expect(doc).toMatchObject({ width: 1080, height: 1920, rev: 1 });
    expect(await readComposition()).toEqual(main);
    expect((await readDocOpLog('best-1')).entries).toHaveLength(1);

    const undo = await undoLastDocOp('best-1');
    expect(undo.undone).toBe(true);
    expect(undo.doc.tracks).toEqual([]);
    expect((await readComposition()).rev).toBe(main.rev);
  });

  it('creates a timeline only when the batch starts with make_short', async () => {
    await resetComposition(sourceOf([clipOf('c1', 0, 30, 0)]));
    const addText = { verb: 'add_text' as const, text: 'Hook', durationSec: 1 };
    await expect(applyVerbs([addText], ctx, 'best-1')).rejects.toBeInstanceOf(NoTimelineError);
    await expect(applyVerbs([addText, makeShort], ctx, 'best-1')).rejects.toBeInstanceOf(
      NoTimelineError,
    );

    const { doc } = await applyVerbs([makeShort, { ...addText, track: 'hook' }], ctx, 'best-1');
    expect(doc.tracks.map((t) => t.id)).toEqual(['v0', 'captions', 'hook']);
  });

  it('refuses to make a short on main', async () => {
    await resetComposition(sourceOf([clipOf('c1', 0, 30, 0)]));
    await expect(applyVerbs([makeShort], ctx)).rejects.toBeInstanceOf(ShortError);
  });
});
