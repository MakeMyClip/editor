import { describe, expect, it } from 'vitest';
import { MissingFontError } from '../src/ffmpeg/font.js';
import { type CompileContext, CompileError, compileTimeline } from '../src/timeline/compile.js';
import { emptyComposition } from '../src/timeline/composition.js';
import { applyOps, colorClip, mediaClip, textClip, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import { parseFilter } from './ffmpeg-parse.js';

const M1 = 'm_aaaaaaaaaaaa' as MediaId;
const M2 = 'm_bbbbbbbbbbbb' as MediaId;

function ctx(over: Partial<CompileContext> = {}): CompileContext {
  return {
    media: new Map([
      [M1, { path: '/ws/a.mp4', hasAudio: true }],
      [M2, { path: '/ws/b.mp4', hasAudio: true }],
    ]),
    dir: '/ws',
    output: '/ws/out.mp4',
    ...over,
  };
}

function oneTrack(...ops: Parameters<typeof applyOps>[1]) {
  return applyOps(emptyComposition(), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    ...ops,
  ]);
}

describe('compileTimeline — single clip', () => {
  it('writes the lone segment straight to the final output', () => {
    const comp = oneTrack({
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c1', mediaId: M1, sourceInSec: 1, sourceOutSec: 6, startSec: 0 }),
    });
    const plan = compileTimeline(comp, ctx());
    expect(plan.steps).toHaveLength(1);
    expect(plan.output).toBe('/ws/out.mp4');
    expect(plan.durationSec).toBe(5);
    const args = plan.steps[0]?.args ?? [];
    // input-seek to the trim point, bounded to the trimmed duration
    expect(args.slice(0, 5)).toEqual(['-y', '-ss', '1', '-i', '/ws/a.mp4']);
    expect(args).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('5');
    expect(args.at(-1)).toBe('/ws/out.mp4');
    // canvas geometry + encode
    const fc = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(fc).toContain('scale=1920:1080:force_original_aspect_ratio=decrease');
    expect(fc).toContain('fps=30');
    expect(args).toContain('libx264');
  });

  it('generates silence for a media clip without an audio stream', () => {
    const comp = oneTrack({
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c1', mediaId: M1, sourceOutSec: 3, startSec: 0 }),
    });
    const plan = compileTimeline(
      comp,
      ctx({ media: new Map([[M1, { path: '/ws/a.mp4', hasAudio: false }]]) }),
    );
    const args = plan.steps[0]?.args ?? [];
    expect(args.join(' ')).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    // The generated silence (input 1) flows through the normalize chain and is
    // mapped from the chain's [a] output.
    const fc = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(fc).toContain('[1:a]aformat=sample_rates=48000:channel_layouts=stereo');
    const mapIdxs = args.map((a, i) => (a === '-map' ? i : -1)).filter((i) => i >= 0);
    expect(args[(mapIdxs[1] ?? -2) + 1]).toBe('[a]');
  });

  it('normalizes every segment audio to stereo/48k (uniform layout for the fold)', () => {
    // A media clip WITH audio and no audio effects must still run aformat, or a
    // mono source would silently downmix the whole timeline at concat/acrossfade.
    const comp = oneTrack({
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'c1', mediaId: M1, sourceOutSec: 3, startSec: 0 }),
    });
    const plan = compileTimeline(comp, ctx());
    const args = plan.steps[0]?.args ?? [];
    const fc = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(fc).toContain('[0:a]aformat=sample_rates=48000:channel_layouts=stereo');
    const mapIdxs = args.map((a, i) => (a === '-map' ? i : -1)).filter((i) => i >= 0);
    expect(args[(mapIdxs[1] ?? -2) + 1]).toBe('[a]');
  });
});

describe('compileTimeline — generated clips', () => {
  it('renders a color clip from a lavfi color source', () => {
    const comp = oneTrack({
      op: 'addClip',
      trackId: 'v0',
      clip: colorClip({ id: 'card', color: 'black', durationSec: 2, startSec: 0 }),
    });
    const plan = compileTimeline(comp, ctx());
    const args = plan.steps[0]?.args ?? [];
    expect(args.join(' ')).toContain('color=c=black:s=1920x1080:r=30');
    expect(plan.durationSec).toBe(2);
  });

  it('burns a text clip via a drawtext textfile (text never enters the graph)', () => {
    const comp = oneTrack({
      op: 'addClip',
      trackId: 'v0',
      clip: textClip({
        id: 'title',
        text: "It's a title: colons & commas",
        durationSec: 3,
        startSec: 0,
      }),
    });
    const plan = compileTimeline(comp, ctx());
    const step = plan.steps[0];
    expect(step?.textFiles).toHaveLength(1);
    expect(step?.textFiles[0]?.content).toBe("It's a title: colons & commas");
    const fc = step?.args[step.args.indexOf('-filter_complex') + 1] ?? '';
    const drawtext = parseFilter(fc.slice(fc.indexOf('drawtext=')));
    expect(drawtext.name).toBe('drawtext');
    expect(drawtext.options.textfile).toBe(step?.textFiles[0]?.path);
    // The raw text must NOT be inlined in the filter graph.
    expect(fc).not.toContain('a title: colons');
  });
});

describe('compileTimeline — effects', () => {
  it('maps adjust → eq, volume → volume, speed → setpts/atempo, fades → fade/afade', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M1, sourceOutSec: 8, startSec: 0 }),
      },
      {
        op: 'addEffect',
        clipId: 'c1',
        effect: { type: 'adjust', brightness: 0.1, contrast: 1.2, saturation: 1 },
      },
      { op: 'addEffect', clipId: 'c1', effect: { type: 'volume', gain: 0.5 } },
      { op: 'addEffect', clipId: 'c1', effect: { type: 'speed', factor: 2 } },
      { op: 'addEffect', clipId: 'c1', effect: { type: 'fadeOut', durationSec: 1 } },
    );
    const plan = compileTimeline(comp, ctx());
    // 8s source at 2× → 4s output
    expect(plan.durationSec).toBe(4);
    const args = plan.steps[0]?.args ?? [];
    const fc = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(fc).toContain('eq=brightness=0.1:contrast=1.2');
    expect(fc).toContain('setpts=PTS/2');
    expect(fc).toContain('atempo=2.0');
    expect(fc).toContain('volume=0.5');
    // fadeOut starts at outDur − d = 3
    expect(fc).toContain('fade=t=out:st=3:d=1');
    expect(fc).toContain('afade=t=out:st=3:d=1');
  });
});

describe('compileTimeline — fold (cuts & transitions)', () => {
  it('hard-cuts three clips into two concat folds, last writing the output', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 2, startSec: 2 }),
      },
      { op: 'addClip', trackId: 'v0', clip: colorClip({ id: 'c', durationSec: 2, startSec: 4 }) },
    );
    const plan = compileTimeline(comp, ctx());
    const labels = plan.steps.map((s) => s.label);
    expect(labels).toEqual(['segment:a', 'segment:b', 'segment:c', 'fold:cut:1', 'fold:cut:2']);
    expect(plan.steps.at(-1)?.output).toBe('/ws/out.mp4');
    expect(plan.durationSec).toBe(6);
    const cut = plan.steps.find((s) => s.label === 'fold:cut:1')?.args ?? [];
    expect(cut.join(' ')).toContain('concat=n=2:v=1:a=1');
  });

  it('xfades where a transition follows a clip and accounts for overlap in duration', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 4, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 4, startSec: 4 }),
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'a', kind: 'dissolve', durationSec: 1 },
      },
    );
    const plan = compileTimeline(comp, ctx());
    const fold = plan.steps.find((s) => s.label === 'fold:xfade:1')?.args ?? [];
    const fc = fold[fold.indexOf('-filter_complex') + 1] ?? '';
    expect(fc).toContain('xfade=transition=dissolve:duration=1:offset=3'); // offset = accDur(4) − 1
    expect(fc).toContain('acrossfade=d=1');
    // 4 + 4 − 1 overlap = 7s
    expect(plan.durationSec).toBe(7);
  });

  it('drops a per-clip fade on a transition boundary but keeps outer fades', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 4, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 4, startSec: 4 }),
      },
      { op: 'addEffect', clipId: 'a', effect: { type: 'fadeIn', durationSec: 1 } },
      { op: 'addEffect', clipId: 'a', effect: { type: 'fadeOut', durationSec: 1 } },
      { op: 'addEffect', clipId: 'b', effect: { type: 'fadeIn', durationSec: 1 } },
      { op: 'addEffect', clipId: 'b', effect: { type: 'fadeOut', durationSec: 1 } },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'a', kind: 'dissolve', durationSec: 1 },
      },
    );
    const plan = compileTimeline(comp, ctx());
    const segA = plan.steps.find((s) => s.label === 'segment:a')?.args ?? [];
    const fcA = segA[segA.indexOf('-filter_complex') + 1] ?? '';
    const segB = plan.steps.find((s) => s.label === 'segment:b')?.args ?? [];
    const fcB = segB[segB.indexOf('-filter_complex') + 1] ?? '';

    // Clip a opens from black (leading fadeIn kept) but its trailing fadeOut is
    // dropped — the dissolve already blends that cut.
    expect(fcA).toContain('fade=t=in:st=0:d=1');
    expect(fcA).not.toContain('fade=t=out');
    expect(fcA).not.toContain('afade=t=out');
    // Clip b's leading fadeIn is dropped (xfade owns it); its trailing fadeOut to
    // black at the timeline end is kept.
    expect(fcB).not.toContain('fade=t=in');
    expect(fcB).not.toContain('afade=t=in');
    expect(fcB).toContain('fade=t=out');
    // The transition fold itself is unaffected.
    expect(plan.steps.some((s) => s.label === 'fold:xfade:1')).toBe(true);
  });

  it('keeps the last clip fadeOut when a transition dangles on it (no following clip to xfade)', () => {
    // A transition keyed to the LAST clip blends nothing (the fold only xfades a
    // transition with a following clip — e.g. one left dangling after the next
    // clip was removed). The fade-to-black must survive, not drop to a hard cut.
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 4, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 4, startSec: 4 }),
      },
      { op: 'addEffect', clipId: 'b', effect: { type: 'fadeOut', durationSec: 1 } },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'b', kind: 'dissolve', durationSec: 1 },
      },
    );
    const plan = compileTimeline(comp, ctx());
    const segB = plan.steps.find((s) => s.label === 'segment:b')?.args ?? [];
    const fcB = segB[segB.indexOf('-filter_complex') + 1] ?? '';
    expect(fcB).toContain('fade=t=out:st=3:d=1'); // preserved
    // No xfade exists for a transition with nothing after it; the join is a cut.
    expect(plan.steps.some((s) => s.label.startsWith('fold:xfade'))).toBe(false);
  });
});

describe('compileTimeline — v1 guards (explicit, not silent-wrong)', () => {
  it('rejects an empty composition', () => {
    expect(() => compileTimeline(emptyComposition(), ctx())).toThrow(CompileError);
  });

  it('rejects more than one populated video track', () => {
    const comp = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      { op: 'addTrack', track: videoTrack({ id: 'v1' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v1',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 2, startSec: 0 }),
      },
    ]);
    expect(() => compileTimeline(comp, ctx())).toThrow(/single video track/i);
  });

  it('rejects a non-identity transform', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
      { op: 'setTransform', clipId: 'a', transform: { scale: 2 } },
    );
    expect(() => compileTimeline(comp, ctx())).toThrow(/transform/i);
  });

  it('rejects chromaKey in single-track export', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
      {
        op: 'addEffect',
        clipId: 'a',
        effect: { type: 'chromaKey', color: 'green', similarity: 0.3, blend: 0.1 },
      },
    );
    expect(() => compileTimeline(comp, ctx())).toThrow(/chromaKey/i);
  });

  it('rejects a missing media registration', () => {
    const comp = oneTrack({
      op: 'addClip',
      trackId: 'v0',
      clip: mediaClip({ id: 'a', mediaId: M2, sourceOutSec: 2, startSec: 0 }),
    });
    expect(() => compileTimeline(comp, ctx({ media: new Map() }))).toThrow(/No media registered/);
  });

  it('rejects a transition longer than an adjacent clip (degenerate/failing fold)', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 2, startSec: 2 }),
      },
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'a', kind: 'fade', durationSec: 3 },
      },
    );
    expect(() => compileTimeline(comp, ctx())).toThrow(
      /shorter than\s+both adjacent clips|must be shorter/i,
    );
  });

  it('rejects a timeline gap between clips instead of silently collapsing it', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 2, startSec: 5 }),
      },
    );
    expect(() => compileTimeline(comp, ctx())).toThrow(/gap/i);
  });

  it('rejects a timeline overlap between clips', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 4, startSec: 0 }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 4, startSec: 2 }),
      },
    );
    expect(() => compileTimeline(comp, ctx())).toThrow(/overlap/i);
  });
});

describe('compileTimeline — fade clamping', () => {
  it('clamps a fadeOut longer than the clip to the clip duration', () => {
    const comp = oneTrack(
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
      { op: 'addEffect', clipId: 'a', effect: { type: 'fadeOut', durationSec: 5 } },
    );
    const plan = compileTimeline(comp, ctx());
    const args = plan.steps[0]?.args ?? [];
    const fc = args[args.indexOf('-filter_complex') + 1] ?? '';
    // d clamped to outDur (2), start = 0 — a full fade within the window.
    expect(fc).toContain('fade=t=out:st=0:d=2');
    expect(fc).toContain('afade=t=out:st=0:d=2');
  });
});

describe('compileTimeline — text over the picture (captions)', () => {
  const caption = (id: string, text: string, startSec: number, durationSec: number) =>
    textClip({ id, text, startSec, durationSec, style: { anchor: 'bottom-center' } });

  /** Two abutting media clips on v0 and the given text clips on a track above. */
  function captioned(texts: ReturnType<typeof caption>[], speed?: number) {
    return applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      { op: 'addTrack', track: videoTrack({ id: 'captions' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({
          id: 'a',
          mediaId: M1,
          sourceInSec: 10,
          sourceOutSec: 14,
          startSec: 0,
          effects: speed ? [{ type: 'speed', factor: speed }] : [],
        }),
      },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'b', mediaId: M2, sourceOutSec: 3, startSec: 4 }),
      },
      ...texts.map((clip) => ({ op: 'addClip' as const, trackId: 'captions', clip })),
    ]);
  }

  /** Every drawtext in a step's graph, parsed the way FFmpeg reads it. */
  function drawtexts(args: string[] | undefined) {
    const fc = args?.[args.indexOf('-filter_complex') + 1] ?? '';
    return fc
      .split('drawtext=')
      .slice(1)
      .map((rest) => parseFilter(`drawtext=${rest}`).options);
  }

  it('draws each caption in the segment it falls in, timed in segment seconds', () => {
    const comp = captioned([
      caption('c1', 'hello there', 0.5, 1.5),
      caption('c2', 'and you', 4.2, 1),
    ]);
    const plan = compileTimeline(comp, ctx({ fontFor: () => undefined }));
    const [segA, segB] = plan.steps;
    expect(drawtexts(segA?.args).map((o) => o.enable)).toEqual(['gte(t,0.5)*lt(t,2)']);
    expect(drawtexts(segB?.args).map((o) => o.enable)).toEqual(['gte(t,0.2)*lt(t,1.2)']);
    expect(segA?.textFiles.map((f) => f.content)).toEqual(['hello there']);
    expect(segB?.textFiles.map((f) => f.content)).toEqual(['and you']);
    // The picture runs only as long as v0; captions don't lengthen the export.
    expect(plan.durationSec).toBe(7);
  });

  it('splits a caption across a cut and draws it over the effects', () => {
    const comp = captioned([caption('c1', 'across', 3.5, 1)]);
    const plan = compileTimeline(comp, ctx({ fontFor: () => undefined }));
    expect(drawtexts(plan.steps[0]?.args)[0]?.enable).toBe('gte(t,3.5)*lt(t,4)');
    expect(drawtexts(plan.steps[1]?.args)[0]?.enable).toBe('gte(t,0)*lt(t,0.5)');
    const fc = plan.steps[0]?.args.join(' ') ?? '';
    expect(fc.indexOf('fps=30')).toBeLessThan(fc.indexOf('drawtext='));
  });

  it('scales caption times with a speed effect so they stay on the speech', () => {
    const comp = captioned([caption('c1', 'fast', 1, 2)], 2);
    const plan = compileTimeline(comp, ctx({ fontFor: () => undefined }));
    expect(drawtexts(plan.steps[0]?.args)[0]?.enable).toBe('gte(t,0.5)*lt(t,1.5)');
  });

  it('turns off % expansion and uses the font that has the glyphs', () => {
    const comp = captioned([caption('c1', 'Привет 50%', 0, 1), caption('c2', 'plain', 1, 1)]);
    const fontFor = (text: string) => (text.startsWith('П') ? '/fonts/Cyr.ttf' : undefined);
    const [cyr, plain] = drawtexts(compileTimeline(comp, ctx({ fontFor })).steps[0]?.args);
    expect(cyr).toMatchObject({ fontfile: '/fonts/Cyr.ttf', expansion: 'none' });
    expect(plain?.fontfile).toBeUndefined();
    expect(plain?.expansion).toBe('none');
  });

  it('reports a missing font as a blocker on the text clip', () => {
    const comp = captioned([caption('c1', '你好', 0, 1)]);
    const fontFor = () => {
      throw new MissingFontError('你好');
    };
    expect(() => compileTimeline(comp, ctx({ fontFor }))).toThrow(/Text clip "c1".*glyphs/);
  });

  it('rejects text under the picture, text past its end, and effects on text over it', () => {
    const under = applyOps(emptyComposition(), [
      { op: 'addTrack', track: videoTrack({ id: 'captions' }) },
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      { op: 'addClip', trackId: 'captions', clip: caption('c1', 'hidden', 0, 1) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'a', mediaId: M1, sourceOutSec: 2, startSec: 0 }),
      },
    ]);
    expect(() => compileTimeline(under, ctx())).toThrow(/under track "v0"/);
    expect(() => compileTimeline(captioned([caption('c1', 'late', 6.5, 1)]), ctx())).toThrow(
      /past the end of the picture/,
    );
    const faded = textClip({
      id: 'c1',
      text: 'x',
      startSec: 0,
      durationSec: 1,
      effects: [{ type: 'fadeIn', durationSec: 0.2 }],
    });
    expect(() => compileTimeline(captioned([faded]), ctx())).toThrow(/has effects/);
  });

  it('still treats a lone text track as the picture (a title sequence)', () => {
    const comp = oneTrack({ op: 'addClip', trackId: 'v0', clip: caption('t', 'Title', 0, 2) });
    const plan = compileTimeline(comp, ctx({ fontFor: () => undefined }));
    expect(drawtexts(plan.steps[0]?.args)[0]?.enable).toBeUndefined();
  });
});
