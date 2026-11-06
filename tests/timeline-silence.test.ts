import { describe, expect, it } from 'vitest';
import { buildSilenceDetectArgs } from '../src/ffmpeg/args/silence-detect.js';
import { checkExportable, compileTimeline, type MediaInfo } from '../src/timeline/compile.js';
import {
  type Composition,
  clipEndSec,
  emptyComposition,
  type MediaClip,
} from '../src/timeline/composition.js';
import {
  applyOp,
  applyOps,
  CompositionOpError,
  mediaClip,
  textClip,
  videoTrack,
} from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import {
  planSilenceCut,
  SilenceAnalysisError,
  sensitivityToDetect,
} from '../src/timeline/silence.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;
const MEDIA = new Map<MediaId, MediaInfo>([[M, { path: '/ws/talk.mp4', hasAudio: true }]]);

/** v0: c1 [0,6) → c2 [6,10), fade transition after c1; v1: a title over c1. */
function doc(): Composition {
  return applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({
        id: 'c1',
        mediaId: M,
        sourceOutSec: 6,
        startSec: 0,
        effects: [
          { type: 'fadeIn', durationSec: 0.5 },
          { type: 'volume', gain: 1.5 },
          { type: 'fadeOut', durationSec: 0.5 },
        ],
      }),
    },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c2', mediaId: M, sourceInSec: 6, sourceOutSec: 10, startSec: 6 }),
    },
    {
      op: 'addTransition',
      trackId: 'v0',
      transition: { afterClipId: 'c1', kind: 'fade', durationSec: 0.5 },
    },
    {
      op: 'addClip',
      trackId: 'v1',
      clip: textClip({ id: 't1', text: 'title', durationSec: 2, startSec: 3 }),
    },
  ]);
}

const CUT = {
  op: 'silenceCut',
  clipId: 'c1',
  keepRegions: [
    { sourceInSec: 0, sourceOutSec: 1.6 },
    { sourceInSec: 2.9, sourceOutSec: 4.6 },
  ],
  newClipIds: ['c1b'],
} as const;

function track(comp: Composition, id: string) {
  const t = comp.tracks.find((x) => x.id === id);
  if (!t) throw new Error(`no track ${id}`);
  return t;
}

describe('silenceCut reducer', () => {
  it('packs one sub-clip per kept window back to back from the clip start', () => {
    const v0 = track(applyOp(doc(), { ...CUT, keepRegions: [...CUT.keepRegions] }), 'v0');
    const [a, b] = v0.clips as MediaClip[];
    expect(a).toMatchObject({ id: 'c1', startSec: 0, sourceInSec: 0, sourceOutSec: 1.6 });
    expect(b).toMatchObject({ id: 'c1b', sourceInSec: 2.9, sourceOutSec: 4.6 });
    expect(b?.startSec).toBeCloseTo(1.6, 10);
  });

  it('ripples later clips on the same track left so the track still abuts', () => {
    const v0 = track(applyOp(doc(), { ...CUT, keepRegions: [...CUT.keepRegions] }), 'v0');
    const ids = v0.clips.map((c) => c.id);
    expect(ids).toEqual(['c1', 'c1b', 'c2']);
    for (let i = 1; i < v0.clips.length; i++) {
      const prev = v0.clips[i - 1];
      const cur = v0.clips[i];
      if (!prev || !cur) throw new Error('missing clip');
      expect(Math.abs(cur.startSec - clipEndSec(prev))).toBeLessThan(1e-4);
    }
    // 6s clip, 3.3s kept → c2 moves from 6 to 3.3.
    expect(v0.clips[2]?.startSec).toBeCloseTo(3.3, 10);
  });

  it('leaves other tracks where they were', () => {
    const after = applyOp(doc(), { ...CUT, keepRegions: [...CUT.keepRegions] });
    expect(track(after, 'v1').clips[0]?.startSec).toBe(3);
  });

  it('moves the transition after the clip to the last sub-clip', () => {
    const v0 = track(applyOp(doc(), { ...CUT, keepRegions: [...CUT.keepRegions] }), 'v0');
    expect(v0.transitions.map((t) => t.afterClipId)).toEqual(['c1b']);
  });

  it('keeps fadeIn on the first sub-clip, fadeOut on the last, other effects on both', () => {
    const v0 = track(applyOp(doc(), { ...CUT, keepRegions: [...CUT.keepRegions] }), 'v0');
    expect(v0.clips[0]?.effects.map((e) => e.type)).toEqual(['fadeIn', 'volume']);
    expect(v0.clips[1]?.effects.map((e) => e.type)).toEqual(['volume', 'fadeOut']);
  });

  it('trims in place with no new ids when only one window is kept', () => {
    const v0 = track(
      applyOp(doc(), {
        op: 'silenceCut',
        clipId: 'c1',
        keepRegions: [{ sourceInSec: 1, sourceOutSec: 5 }],
        newClipIds: [],
      }),
      'v0',
    );
    expect(v0.clips[0]).toMatchObject({ id: 'c1', startSec: 0, sourceInSec: 1, sourceOutSec: 5 });
    expect(v0.clips[1]?.startSec).toBe(4);
    expect(v0.transitions.map((t) => t.afterClipId)).toEqual(['c1']);
  });

  it('does not mutate its input', () => {
    const pre = doc();
    const frozen = structuredClone(pre);
    applyOp(pre, { ...CUT, keepRegions: [...CUT.keepRegions] });
    expect(pre).toEqual(frozen);
  });

  it.each([
    [
      'a text clip',
      { clipId: 't1', keepRegions: [{ sourceInSec: 0, sourceOutSec: 1 }], newClipIds: [] },
    ],
    ['no kept regions', { keepRegions: [] }],
    ['a missing new id', { newClipIds: [] }],
    ['a region past the out point', { keepRegions: [{ sourceInSec: 0, sourceOutSec: 7 }] }],
    [
      'overlapping regions',
      {
        keepRegions: [
          { sourceInSec: 0, sourceOutSec: 3 },
          { sourceInSec: 2, sourceOutSec: 4 },
        ],
      },
    ],
    ['a new id equal to the clip id', { newClipIds: ['c1'] }],
    ['a new id already in the doc', { newClipIds: ['c2'] }],
  ])('rejects %s', (_label, patch) => {
    const bad = { ...CUT, keepRegions: [...CUT.keepRegions], newClipIds: [...CUT.newClipIds] };
    const op = { ...bad, ...patch } as Parameters<typeof applyOp>[1];
    expect(() => applyOp(doc(), op)).toThrow(CompositionOpError);
  });

  it('compiles: the cut track exports as abutting trimmed segments', () => {
    const cut = applyOps(doc(), [
      { op: 'removeTrack', trackId: 'v1' },
      { ...CUT, keepRegions: [...CUT.keepRegions] },
    ]);
    expect(checkExportable(cut, MEDIA, '/ws')).toEqual({ exportable: true, blockers: [] });
    const plan = compileTimeline(cut, { media: MEDIA, dir: '/ws', output: '/ws/out.mp4' });
    const seek = plan.steps
      .filter((s) => s.label.startsWith('segment:'))
      .map((s) => {
        const a = s.args;
        return [a[a.indexOf('-ss') + 1], a[a.indexOf('-t') + 1]];
      });
    expect(seek[0]).toEqual(['0', '1.6']);
    expect(seek[1]?.[0]).toBe('2.9');
    expect(Number(seek[1]?.[1])).toBeCloseTo(1.7, 10);
    expect(seek[2]).toEqual(['6', '4']);
  });
});

// Real FFmpeg 6.0 output for `-ss 1 -t 4` over a clip with sound at [0,1.5) and
// [3,4.5) and silence elsewhere: times are relative to the window start, and the
// silence running to the window end is closed at 4.
const WINDOW_STDERR = `[silencedetect @ 0x1] silence_start: 0.499979
[silencedetect @ 0x1] silence_end: 2.00004 | silence_duration: 1.50006
[silencedetect @ 0x1] silence_start: 3.49998
[silencedetect @ 0x1] silence_end: 4 | silence_duration: 0.500021`;

function counter(): () => string {
  let n = 0;
  return () => `new${++n}`;
}

describe('planSilenceCut', () => {
  // c1 is a 4s window (source 1..5) of the media.
  const trimmed = applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    {
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c1', mediaId: M, sourceInSec: 1, sourceOutSec: 5, startSec: 0 }),
    },
  ]);

  it('keeps pauses so the first sub-clip outlasts an incoming transition', () => {
    // c0 → 0.5s fade → c1. c1's sound: [0,0.2) and [2,3); padded, the first
    // kept region is only 0.3s, too short to follow the fade.
    const withFadeIn = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c0', mediaId: M, sourceOutSec: 2, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M, sourceInSec: 1, sourceOutSec: 5, startSec: 2 }),
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'c0', kind: 'fade', durationSec: 0.5 },
      },
    ]);
    const stderr = 'silence_start: 0.2\nsilence_end: 2\nsilence_start: 3\nsilence_end: 4';
    expect(
      planSilenceCut(trimmed, 'c1', stderr, { media: MEDIA, mintId: counter() }).keepRegions,
    ).toHaveLength(2);

    const cut = planSilenceCut(withFadeIn, 'c1', stderr, { media: MEDIA, mintId: counter() });
    expect(cut.keepRegions).toHaveLength(1);
    expect(cut.keepRegions[0]?.sourceInSec).toBe(1);
    expect(cut.keepRegions[0]?.sourceOutSec).toBeCloseTo(4.1, 10);
    if (!cut.op) throw new Error('expected a cut');
    const after = applyOp(withFadeIn, cut.op);
    expect(checkExportable(after, MEDIA, '/ws')).toEqual({ exportable: true, blockers: [] });
  });

  it('rejects a clip that is not media', () => {
    const withText = applyOps(trimmed, [
      {
        op: 'addClip',
        trackId: 'v0',
        clip: textClip({ id: 't', text: 'x', durationSec: 1, startSec: 4 }),
      },
    ]);
    expect(() => planSilenceCut(withText, 't', '', { media: MEDIA, mintId: counter() })).toThrow(
      SilenceAnalysisError,
    );
  });

  describe('never makes an exportable timeline unexportable', () => {
    // a [0,2) then c1 (4s), with a 0.5s fade on one side of c1. c1 keeps only
    // 0.3s of sound, too short for the fade either way.
    function around(fadeAfter: 'a' | 'c1', c1First = false): Composition {
      const a = mediaClip({ id: 'a', mediaId: M, sourceOutSec: 2, startSec: c1First ? 4 : 0 });
      const c1 = mediaClip({
        id: 'c1',
        mediaId: M,
        sourceInSec: 1,
        sourceOutSec: 5,
        startSec: c1First ? 0 : 2,
      });
      return applyOps(emptyComposition(), [
        { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
        { op: 'addClip', trackId: 'v0', clip: a },
        { op: 'addClip', trackId: 'v0', clip: c1 },
        {
          op: 'addTransition',
          trackId: 'v0',
          transition: { afterClipId: fadeAfter, kind: 'fade', durationSec: 0.5 },
        },
      ]);
    }
    const shortSound = 'silence_start: 0.2\nsilence_end: 4';

    it('rejects a lone kept region shorter than the incoming transition', () => {
      expect(() =>
        planSilenceCut(around('a'), 'c1', shortSound, { media: MEDIA, mintId: counter() }),
      ).toThrow(/stop the timeline from exporting/);
    });

    it('rejects a cut that leaves the opening clip shorter than its outgoing transition', () => {
      expect(() =>
        planSilenceCut(around('c1', true), 'c1', shortSound, { media: MEDIA, mintId: counter() }),
      ).toThrow(/stop the timeline from exporting/);
    });

    it('still cuts a timeline that was not exportable to begin with', () => {
      const twoTracks = applyOps(around('a'), [
        { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
        {
          op: 'addClip',
          trackId: 'v1',
          clip: textClip({ id: 't', text: 'x', durationSec: 1, startSec: 0 }),
        },
      ]);
      const cut = planSilenceCut(twoTracks, 'c1', shortSound, { media: MEDIA, mintId: counter() });
      expect(cut.op).toMatchObject({ op: 'silenceCut', clipId: 'c1' });
    });
  });

  it('offsets window-relative silences by the clip in point and pads speech', () => {
    const cut = planSilenceCut(trimmed, 'c1', WINDOW_STDERR, { media: MEDIA, mintId: counter() });
    expect(cut.silenceCount).toBe(2);
    expect(cut.keepRegions).toHaveLength(2);
    expect(cut.keepRegions[0]?.sourceInSec).toBe(1);
    expect(cut.keepRegions[0]?.sourceOutSec).toBeCloseTo(1.599979, 6);
    expect(cut.keepRegions[1]?.sourceInSec).toBeCloseTo(2.90004, 6);
    expect(cut.keepRegions[1]?.sourceOutSec).toBeCloseTo(4.59998, 6);
    expect(cut.removedSec).toBe(1.7);
    expect(cut.op).toEqual({
      op: 'silenceCut',
      clipId: 'c1',
      keepRegions: cut.keepRegions,
      newClipIds: ['new1'],
    });
  });

  it('clamps a silence end reported past the window and snaps to the out point', () => {
    const cut = planSilenceCut(
      trimmed,
      'c1',
      'silence_start: 3.0\nsilence_end: 4.016 | silence_duration: 1.016',
      { media: MEDIA, mintId: counter() },
    );
    expect(cut.keepRegions).toEqual([{ sourceInSec: 1, sourceOutSec: 4.1 }]);
    expect(cut.op).toMatchObject({ op: 'silenceCut', newClipIds: [] });
  });

  it('drops kept blips too short to be speech', () => {
    // 0.05s of sound between two silences: after padding it's under the minimum.
    const cut = planSilenceCut(
      trimmed,
      'c1',
      'silence_start: 0.5\nsilence_end: 1.5\nsilence_start: 1.55\nsilence_end: 3.0',
      { media: MEDIA, mintId: counter() },
    );
    expect(cut.keepRegions).toHaveLength(2);
    expect(cut.keepRegions[0]?.sourceOutSec).toBeCloseTo(1.6, 10);
    expect(cut.keepRegions[1]?.sourceInSec).toBeCloseTo(3.9, 10);
  });

  it('keeps a pause that padding would shrink below a worthwhile cut', () => {
    // 0.35s pause minus 0.1s padding each side leaves 0.15s: not worth a jump cut.
    const cut = planSilenceCut(
      trimmed,
      'c1',
      'silence_start: 1.0\nsilence_end: 1.35\nsilence_start: 2.5\nsilence_end: 4',
      { media: MEDIA, mintId: counter() },
    );
    expect(cut.keepRegions).toHaveLength(1);
    expect(cut.keepRegions[0]?.sourceInSec).toBe(1);
    expect(cut.keepRegions[0]?.sourceOutSec).toBeCloseTo(3.6, 10);
    expect(cut.op).toMatchObject({ op: 'silenceCut', newClipIds: [] });
  });

  it('returns no op when nothing is silent', () => {
    const cut = planSilenceCut(trimmed, 'c1', '', { media: MEDIA, mintId: counter() });
    expect(cut.op).toBeNull();
    expect(cut.keepRegions).toEqual([{ sourceInSec: 1, sourceOutSec: 5 }]);
    expect(cut.removedSec).toBe(0);
  });

  it('leaves a clip shorter than a speech blip alone when nothing is silent', () => {
    const tiny = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M, sourceOutSec: 0.05, startSec: 0 }),
      },
    ]);
    const cut = planSilenceCut(tiny, 'c1', '', { media: MEDIA, mintId: counter() });
    expect(cut.op).toBeNull();
    expect(cut.keepRegions).toEqual([{ sourceInSec: 0, sourceOutSec: 0.05 }]);
  });

  it('refuses to cut a clip that is all silence', () => {
    expect(() =>
      planSilenceCut(trimmed, 'c1', 'silence_start: 0\nsilence_end: 4', {
        media: MEDIA,
        mintId: counter(),
      }),
    ).toThrow(SilenceAnalysisError);
  });
});

describe('sensitivityToDetect', () => {
  it('maps 0, 0.5 and 1 onto the threshold and minimum silence', () => {
    expect(sensitivityToDetect(0)).toEqual({ noiseDb: -40, minSilenceSec: 1 });
    expect(sensitivityToDetect(0.5)).toEqual({ noiseDb: -30, minSilenceSec: 0.5 });
    expect(sensitivityToDetect(1)).toEqual({ noiseDb: -20, minSilenceSec: 0.25 });
  });

  it('rejects values outside 0..1', () => {
    expect(() => sensitivityToDetect(1.5)).toThrow();
    expect(() => sensitivityToDetect(-0.1)).toThrow();
  });
});

describe('buildSilenceDetectArgs', () => {
  it('analyzes the first audio stream of the clip window over a silent bed', () => {
    expect(
      buildSilenceDetectArgs({
        input: '/ws/talk.mp4',
        startSec: 1,
        durationSec: 4,
        noiseDb: -30,
        minSilenceSec: 0.5,
      }),
    ).toEqual([
      '-hide_banner',
      '-nostats',
      '-ss',
      '1',
      '-t',
      '4',
      '-i',
      '/ws/talk.mp4',
      '-filter_complex',
      'anullsrc=r=48000:cl=stereo,atrim=duration=4[bed];' +
        '[0:a:0]aresample=async=1:first_pts=0[src];' +
        '[bed][src]amix=inputs=2:duration=first:normalize=0,' +
        'silencedetect=noise=-30dB:d=0.5[out]',
      '-map',
      '[out]',
      '-f',
      'null',
      '-',
    ]);
  });
});
