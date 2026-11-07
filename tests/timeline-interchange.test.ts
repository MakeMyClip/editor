import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { parseTimecode } from '../src/ffmpeg/probe.js';
import {
  type Clip,
  type Composition,
  CompositionSchema,
  type Transition,
} from '../src/timeline/composition.js';
import {
  buildInterchange,
  exportInterchange,
  InterchangeError,
  type InterchangeMedia,
  interchangeFormatFor,
} from '../src/timeline/interchange.js';
import { parseColor, timecodeFrames } from '../src/timeline/interchange-layout.js';
import { colorClip, mediaClip, textClip } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';

const A = 'm_aaaaaaaaaaaa' as MediaId;
const B = 'm_bbbbbbbbbbbb' as MediaId;

function source(path: string, over: Partial<InterchangeMedia> = {}): InterchangeMedia {
  return {
    path,
    durationSec: 60,
    video: { codec: 'h264', width: 3840, height: 2160, fps: 30 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 'stereo' },
    ...over,
  };
}

const MEDIA = new Map<MediaId, InterchangeMedia>([
  [A, source('/footage/take one.mov')],
  [B, source('/footage/b.mp4')],
]);

interface TrackSpec {
  id: string;
  kind?: 'video' | 'audio';
  clips: Clip[];
  transitions?: Partial<Transition>[];
}

function doc(tracks: TrackSpec[], canvas: Partial<Composition> = {}): Composition {
  return CompositionSchema.parse({
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    ...canvas,
    tracks: tracks.map((t) => ({ kind: 'video', transitions: [], ...t })),
  });
}

function media(id: string, startSec: number, inSec: number, outSec: number, mediaId = A): Clip {
  return mediaClip({ id, mediaId, startSec, sourceInSec: inSec, sourceOutSec: outSec });
}

function exportAs(
  format: 'fcpxml' | 'xmeml',
  comp: Composition,
  sources: Map<MediaId, InterchangeMedia> = MEDIA,
) {
  return buildInterchange(comp, sources, {
    format,
    output: format === 'fcpxml' ? '/out/My Cut.fcpxml' : '/out/My Cut.xml',
  });
}

function parse(xml: string): Element {
  const errors: string[] = [];
  const dom = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') errors.push(message);
    },
  }).parseFromString(xml, 'text/xml');
  expect(errors).toEqual([]);
  return dom.documentElement as unknown as Element;
}

function all(root: Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName(name)) as Element[];
}

function one(root: Element, name: string): Element {
  const found = all(root, name)[0];
  if (!found) throw new Error(`no <${name}>`);
  return found;
}

/** Child elements of a node, by tag name. */
function children(node: Element): Element[] {
  return Array.from(node.childNodes).filter((n) => n.nodeType === 1) as Element[];
}

function text(root: Element, name: string): string {
  return one(root, name).textContent ?? '';
}

function fcpxml(comp: Composition, sources?: Map<MediaId, InterchangeMedia>): Element {
  return parse(exportAs('fcpxml', comp, sources).files[0]?.content ?? '');
}

describe('interchange — FCPXML', () => {
  it('writes a 1.10 document with the source as an absolute file URL', () => {
    const out = exportAs('fcpxml', doc([{ id: 'v0', clips: [media('c1', 0, 1.5, 6.5)] }]));
    const content = out.files[0]?.content ?? '';
    expect(content.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>')).toBe(
      true,
    );
    const root = parse(content);
    expect(root.getAttribute('version')).toBe('1.10');
    expect(one(root, 'media-rep').getAttribute('src')).toBe('file:///footage/take%20one.mov');
    const [sequenceFormat, sourceFormat] = all(root, 'format');
    expect(sequenceFormat?.getAttribute('frameDuration')).toBe('1/30s');
    expect(sequenceFormat?.getAttribute('width')).toBe('1920');
    expect(sourceFormat?.getAttribute('width')).toBe('3840');
    const asset = one(root, 'asset');
    expect(asset.getAttribute('hasAudio')).toBe('1');
    expect(asset.getAttribute('audioChannels')).toBe('2');
    expect(one(root, 'project').getAttribute('name')).toBe('My Cut');
    const clip = one(root, 'asset-clip');
    expect(clip.getAttribute('offset')).toBe('0s');
    expect(clip.getAttribute('start')).toBe('3/2s');
    expect(clip.getAttribute('duration')).toBe('5s');
    expect(clip.getAttribute('format')).toBe(sourceFormat?.getAttribute('id'));
    expect(one(root, 'sequence').getAttribute('duration')).toBe('5s');
    expect(out.durationSec).toBe(5);
  });

  it('writes frame-accurate rational times at 29.97', () => {
    const root = fcpxml(
      doc([{ id: 'v0', clips: [media('c1', 0, 10, 15), media('c2', 5, 20.01, 22)] }], {
        fps: 29.97,
      }),
      new Map([
        [
          A,
          source('/footage/a.mov', {
            video: { codec: 'h264', width: 1920, height: 1080, fps: 29.97 },
          }),
        ],
      ]),
    );
    expect(all(root, 'format')[0]?.getAttribute('frameDuration')).toBe('1001/30000s');
    const [c1, c2] = all(root, 'asset-clip');
    // 10s → frame 300 → 300 × 1001/30000 s.
    expect(c1?.getAttribute('start')).toBe('1001/100s');
    // 5s → 150 frames.
    expect(c1?.getAttribute('duration')).toBe('1001/200s');
    expect(c2?.getAttribute('offset')).toBe('1001/200s');
    // 20.01s rounds to frame 600 (20.0200s), on a frame boundary.
    expect(c2?.getAttribute('start')).toBe('1001/50s');
    // Edges round to frames, not lengths: 5s → frame 150, 6.99s → frame 209.
    expect(c2?.getAttribute('duration')).toBe('59059/30000s');
  });

  it('lays clips end to end in timeline order', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [media('late', 7, 0, 2, B), media('first', 0, 30, 34), media('mid', 4, 10, 13)],
        },
      ]),
    );
    const spine = one(root, 'spine');
    const clips = children(spine);
    expect(clips.map((c) => c.getAttribute('offset'))).toEqual(['0s', '4s', '7s']);
    expect(clips.map((c) => c.getAttribute('start'))).toEqual(['30s', '10s', '0s']);
    expect(clips[2]?.getAttribute('ref')).not.toBe(clips[0]?.getAttribute('ref'));
  });

  it('centers a transition on the edit so the cut matches the mp4 export', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 5), media('b', 5, 10, 15, B)],
          transitions: [{ afterClipId: 'a', kind: 'fade', durationSec: 1 }],
        },
      ]),
    );
    const items = children(one(root, 'spine'));
    expect(items.map((e) => e.tagName)).toEqual(['asset-clip', 'transition', 'asset-clip']);
    const [a, t, b] = items;
    // The mp4 overlaps the clips by 1s (9s long); the editor keeps them end to
    // end with the edit 15 frames into the overlap.
    expect(a?.getAttribute('duration')).toBe('9/2s');
    expect(t?.getAttribute('offset')).toBe('4s');
    expect(t?.getAttribute('duration')).toBe('1s');
    expect(b?.getAttribute('offset')).toBe('9/2s');
    expect(b?.getAttribute('start')).toBe('21/2s');
    expect(b?.getAttribute('duration')).toBe('9/2s');
    expect(one(root, 'sequence').getAttribute('duration')).toBe('9s');
    const dissolve = all(root, 'effect').find((e) => e.getAttribute('name') === 'Cross Dissolve');
    expect(dissolve?.getAttribute('uid')).toBe('FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265');
    expect(one(t as Element, 'filter-video').getAttribute('ref')).toBe(
      dissolve?.getAttribute('id'),
    );
    expect(one(t as Element, 'filter-audio').getAttribute('name')).toBe('Audio Crossfade');
  });

  it('splits an odd-frame transition a frame later into the outgoing clip', () => {
    const items = children(
      one(
        fcpxml(
          doc([
            {
              id: 'v0',
              clips: [media('a', 0, 0, 5), media('b', 5, 0, 5, B)],
              transitions: [{ afterClipId: 'a', durationSec: 0.5 }],
            },
          ]),
        ),
        'spine',
      ),
    );
    const [a, t, b] = items;
    // 15 frames: A keeps 150 − 7, the blend starts 8 frames before the edit.
    expect(a?.getAttribute('duration')).toBe('143/30s');
    expect(t?.getAttribute('offset')).toBe('9/2s');
    expect(t?.getAttribute('duration')).toBe('1/2s');
    expect(b?.getAttribute('start')).toBe('4/15s');
    expect(b?.getAttribute('duration')).toBe('71/15s');
  });

  it('connects captions as Basic Titles on a lane, timed in the clip they sit on', () => {
    const root = fcpxml(
      doc([
        { id: 'v0', clips: [media('a', 0, 20, 30)] },
        {
          id: 'captions',
          clips: [
            textClip({
              id: 't1',
              text: 'Hello & welcome',
              startSec: 1,
              durationSec: 2,
              style: { color: '#ffcc00', anchor: 'bottom-center', fontSize: 54 },
            }),
            textClip({ id: 't2', text: 'Second', startSec: 3, durationSec: 1.5 }),
          ],
        },
      ]),
    );
    const clip = one(root, 'asset-clip');
    const titles = all(clip, 'title');
    expect(titles).toHaveLength(2);
    const [t1, t2] = titles;
    expect(t1?.getAttribute('lane')).toBe('1');
    // Connected offsets are in the clip's own time: its start (20s) + 1s.
    expect(t1?.getAttribute('offset')).toBe('21s');
    expect(t1?.getAttribute('duration')).toBe('2s');
    expect(t2?.getAttribute('offset')).toBe('23s');
    expect(text(t1 as Element, 'text-style')).toBe('Hello & welcome');
    const style = all(t1 as Element, 'text-style')[1];
    expect(style?.getAttribute('fontColor')).toBe('1 0.8 0 1');
    expect(style?.getAttribute('fontSize')).toBe('54');
    const position = all(t1 as Element, 'param').find((p) => p.getAttribute('name') === 'Position');
    // bottom-center: 1080/2 − 40 − 54/2 = 473 px below center.
    expect(position?.getAttribute('value')).toBe('0 -473');
    const basic = all(root, 'effect').find((e) => e.getAttribute('name') === 'Basic Title');
    expect(t1?.getAttribute('ref')).toBe(basic?.getAttribute('id'));
  });

  it('keeps one title across a transition, in output time', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 5), media('b', 5, 0, 5, B)],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
        {
          id: 'captions',
          clips: [textClip({ id: 't', text: 'Across', startSec: 3, durationSec: 4 })],
        },
      ]),
    );
    const titles = all(root, 'title');
    expect(titles).toHaveLength(1);
    // Doc 3s–7s: starts at 3s on A, ends at 7s − 1s of overlap = 6s.
    expect(titles[0]?.getAttribute('offset')).toBe('3s');
    expect(titles[0]?.getAttribute('duration')).toBe('3s');
  });

  it('keeps a fast source in-point on its own frame, not the sequence frame', () => {
    const fast = new Map([
      [
        A,
        source('/footage/a.mov', { video: { codec: 'h264', width: 1920, height: 1080, fps: 60 } }),
      ],
    ]);
    const comp = doc([{ id: 'v0', clips: [media('a', 0, 1 / 60, 2)] }]);
    expect(one(fcpxml(comp, fast), 'asset-clip').getAttribute('start')).toBe('1/60s');
    const clip = one(parse(exportAs('xmeml', comp, fast).files[0]?.content ?? ''), 'clipitem');
    expect(text(one(clip, 'rate'), 'timebase')).toBe('60');
    expect(text(clip, 'in')).toBe('1');
  });

  it('cross-fades captions a transition makes overlap, on separate lanes', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 5), media('b', 5, 0, 5, B)],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
        {
          id: 'captions',
          clips: [
            textClip({ id: 't1', text: 'Before', startSec: 3, durationSec: 2 }),
            textClip({ id: 't2', text: 'After', startSec: 5, durationSec: 2 }),
          ],
        },
      ]),
    );
    const [t1, t2] = all(root, 'title');
    // Output 3–5s and 4–6s: the mp4 fades the first out as the second fades in.
    expect([t1?.getAttribute('lane'), t2?.getAttribute('lane')]).toEqual(['1', '2']);
    expect(one(t1 as Element, 'fadeOut').getAttribute('duration')).toBe('1s');
    expect(one(t2 as Element, 'fadeIn').getAttribute('duration')).toBe('1s');
  });

  it('fades a caption with its clip under a transition, and holds one that spans it', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 5), media('b', 5, 0, 5, B)],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
        {
          id: 'captions',
          clips: [
            textClip({ id: 'alone', text: 'Fading', startSec: 4, durationSec: 1 }),
            textClip({ id: 'spans', text: 'Steady', startSec: 2, durationSec: 0.5 }),
          ],
        },
        {
          id: 'titles',
          clips: [textClip({ id: 'across', text: 'Across', startSec: 3, durationSec: 4 })],
        },
      ]),
    );
    const byText = (t: string): Element =>
      all(root, 'title').find((e) => e.getAttribute('name') === t) as Element;
    // A fades out over 4–5s in output; a caption only on A fades with it.
    expect(one(byText('Fading'), 'fadeOut').getAttribute('duration')).toBe('1s');
    expect(all(byText('Steady'), 'adjust-blend')).toHaveLength(0);
    // On both A and B through the blend: it stays.
    expect(all(byText('Across'), 'adjust-blend')).toHaveLength(0);
  });

  it('stacks overlapping text of one track in start order, later on top', () => {
    const root = fcpxml(
      doc([
        { id: 'v0', clips: [media('a', 0, 0, 5)] },
        {
          id: 'captions',
          clips: [
            textClip({ id: 't1', text: 'One', startSec: 0, durationSec: 2 }),
            textClip({ id: 't2', text: 'Two', startSec: 1, durationSec: 3 }),
            textClip({ id: 't3', text: 'Three', startSec: 2, durationSec: 2 }),
          ],
        },
        {
          id: 'titles',
          clips: [textClip({ id: 'top', text: 'Top', startSec: 0, durationSec: 1 })],
        },
      ]),
    );
    const lanes = Object.fromEntries(
      all(root, 'title').map((t) => [t.getAttribute('name'), t.getAttribute('lane')]),
    );
    expect(lanes).toEqual({ One: '1', Two: '2', Three: '3', Top: '4' });
  });

  it('keeps both appearances of text that flashes on either side of a transition', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 5), media('b', 5, 0, 5, B)],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
        {
          id: 'captions',
          clips: [textClip({ id: 't', text: 'Edge', startSec: 4.8, durationSec: 0.4 })],
        },
      ]),
    );
    // On A at 4.8–5.0s; on B, which starts 1s earlier in output time, at 4.0–4.2s.
    // Each sits on the clip at its start, in that clip's own time: A from 0s, so
    // 4s; B is on screen from 4.5s showing its source from 0.5s, so 4.8s → 0.8s.
    const titles = all(root, 'title').map((t) => [
      t.getAttribute('offset'),
      t.getAttribute('duration'),
    ]);
    expect(titles).toEqual([
      ['4s', '1/5s'],
      ['4/5s', '1/5s'],
    ]);
  });

  it('writes a gap, a black card as a gap and a colored card as a solid', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [
            media('a', 2, 0, 3),
            colorClip({ id: 'k', startSec: 5, durationSec: 1 }),
            colorClip({ id: 'r', startSec: 6, durationSec: 1, color: 'red' }),
          ],
        },
        {
          id: 'captions',
          clips: [textClip({ id: 't', text: 'Intro', startSec: 0.5, durationSec: 1 })],
        },
      ]),
    );
    const items = children(one(root, 'spine'));
    expect(items.map((e) => e.tagName)).toEqual(['gap', 'asset-clip', 'gap', 'video']);
    expect(items[0]?.getAttribute('duration')).toBe('2s');
    expect(items[2]?.getAttribute('name')).toBe('Black');
    // The title over the leading gap is connected to it, in its local time.
    const title = one(items[0] as Element, 'title');
    expect(title.getAttribute('offset')).toBe('7201/2s');
    const solid = items[3] as Element;
    expect(one(solid, 'param').getAttribute('value')).toBe('1 0 0');
    expect(all(root, 'effect').some((e) => e.getAttribute('name') === 'Custom')).toBe(true);
  });

  it('writes fades and volume as opacity and volume fade handles', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [
            mediaClip({
              id: 'a',
              mediaId: A,
              startSec: 0,
              sourceOutSec: 4,
              effects: [
                { type: 'fadeIn', durationSec: 0.5 },
                { type: 'fadeOut', durationSec: 1 },
                { type: 'volume', gain: 0.5 },
              ],
            }),
          ],
        },
      ]),
    );
    const blend = one(root, 'adjust-blend');
    expect(one(blend, 'fadeIn').getAttribute('duration')).toBe('1/2s');
    expect(one(blend, 'fadeOut').getAttribute('duration')).toBe('1s');
    const volume = one(root, 'adjust-volume');
    expect(volume.getAttribute('amount')).toBe('-6.0206dB');
    expect(one(volume, 'fadeIn').getAttribute('type')).toBe('linear');
  });

  it('drops a clip fade where a transition blends that edge, as the mp4 export does', () => {
    const root = fcpxml(
      doc([
        {
          id: 'v0',
          clips: [
            mediaClip({
              id: 'a',
              mediaId: A,
              startSec: 0,
              sourceOutSec: 4,
              effects: [{ type: 'fadeOut', durationSec: 1 }],
            }),
            media('b', 4, 0, 4, B),
          ],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
      ]),
    );
    expect(all(root, 'adjust-blend')).toHaveLength(0);
  });

  it('places camera media by its start timecode', () => {
    const tc = new Map<MediaId, InterchangeMedia>([
      [
        A,
        source('/footage/a.mov', {
          video: { codec: 'prores', width: 1920, height: 1080, fps: 23.976 },
          timecode: '01:00:00:00',
        }),
      ],
    ]);
    const root = fcpxml(doc([{ id: 'v0', clips: [media('a', 0, 2, 4)] }], { fps: 23.976 }), tc);
    // 01:00:00:00 at 23.976 is frame 86400 = 3603.6s.
    expect(one(root, 'asset').getAttribute('start')).toBe('18018/5s');
    // + 2s, which rounds to 48 frames: (86400 + 48) × 1001/24000 s.
    expect(one(root, 'asset-clip').getAttribute('start')).toBe('1802801/500s');
  });

  it('reports a text background box it cannot carry', () => {
    const out = exportAs(
      'fcpxml',
      doc([
        { id: 'v0', clips: [media('a', 0, 0, 5)] },
        {
          id: 'captions',
          clips: [
            textClip({
              id: 't',
              text: 'Hi',
              startSec: 0,
              durationSec: 1,
              style: { background: 'black@0.6' },
            }),
          ],
        },
      ]),
    );
    expect(out.notes.join(' ')).toMatch(/background boxes/i);
  });
});

describe('interchange — refusals', () => {
  const refuse = (comp: Composition, pattern: RegExp, sources = MEDIA): void => {
    expect(() => exportAs('fcpxml', comp, sources)).toThrow(InterchangeError);
    expect(() => exportAs('fcpxml', comp, sources)).toThrow(pattern);
  };
  const withEffect = (effect: Clip['effects'][number]): Composition =>
    doc([
      {
        id: 'v0',
        clips: [
          mediaClip({ id: 'a', mediaId: A, startSec: 0, sourceOutSec: 3, effects: [effect] }),
        ],
      },
    ]);

  it('refuses speed, color adjustment and chroma key', () => {
    refuse(withEffect({ type: 'speed', factor: 2 }), /speed effect/);
    refuse(
      withEffect({ type: 'adjust', brightness: 0.1, contrast: 1, saturation: 1 }),
      /color adjustment/,
    );
    refuse(
      withEffect({ type: 'chromaKey', color: 'green', similarity: 0.3, blend: 0.1 }),
      /chromaKey/,
    );
  });

  it('refuses a fade in and out that overlap', () => {
    refuse(
      doc([
        {
          id: 'v0',
          clips: [
            mediaClip({
              id: 'a',
              mediaId: A,
              startSec: 0,
              sourceOutSec: 4,
              effects: [
                { type: 'fadeIn', durationSec: 3 },
                { type: 'fadeOut', durationSec: 3 },
              ],
            }),
          ],
        },
      ]),
      /fades overlap/,
    );
  });

  it('refuses two fades of one kind on a clip', () => {
    refuse(
      doc([
        {
          id: 'v0',
          clips: [
            mediaClip({
              id: 'a',
              mediaId: A,
              startSec: 0,
              sourceOutSec: 6,
              effects: [
                { type: 'fadeIn', durationSec: 2 },
                { type: 'fadeIn', durationSec: 2 },
              ],
            }),
          ],
        },
      ]),
      /2 fade-in effects/,
    );
  });

  it('refuses a transform', () => {
    refuse(
      doc([
        {
          id: 'v0',
          clips: [
            mediaClip({
              id: 'a',
              mediaId: A,
              startSec: 0,
              sourceOutSec: 3,
              transform: { scale: 2 },
            }),
          ],
        },
      ]),
      /transform/,
    );
  });

  it('refuses transitions other than fade and dissolve, naming the fix', () => {
    refuse(
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 3), media('b', 3, 0, 3)],
          transitions: [{ afterClipId: 'a', kind: 'wipeleft', durationSec: 1 }],
        },
      ]),
      /"wipeleft".*Change it to fade or dissolve/,
    );
  });

  it('refuses a transition before a gap and one longer than its clips', () => {
    refuse(
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 3), media('b', 4, 0, 3)],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
      ]),
      /followed by a gap/,
    );
    refuse(
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 1), media('b', 1, 0, 3)],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
      ]),
      /shorter than both clips/,
    );
  });

  it('refuses transitions that would overlap around a short clip', () => {
    const around = (sec: number): Composition =>
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 3), media('b', 3, 0, 1), media('c', 4, 0, 3)],
          transitions: [
            { afterClipId: 'a', durationSec: sec },
            { afterClipId: 'b', durationSec: sec },
          ],
        },
      ]);
    refuse(around(0.9), /"b" is shorter than the transitions on both sides/);
    // Two half-second blends exactly fill the 1s clip: they meet, not overlap.
    expect(() => exportAs('fcpxml', around(0.5))).not.toThrow();
  });

  it('refuses overlaps, audio tracks and media on two tracks', () => {
    refuse(doc([{ id: 'v0', clips: [media('a', 0, 0, 3), media('b', 2, 0, 3)] }]), /overlap/);
    refuse(
      doc([
        { id: 'v0', clips: [media('a', 0, 0, 3)] },
        { id: 'a0', kind: 'audio', clips: [media('m', 0, 0, 3, B)] },
      ]),
      /audio tracks/,
    );
    refuse(
      doc([
        { id: 'v0', clips: [media('a', 0, 0, 3)] },
        { id: 'v1', clips: [media('b', 0, 0, 3, B)] },
      ]),
      /more than one track/,
    );
  });

  it('refuses a rate editors do not offer, a color it cannot read and text past the end', () => {
    refuse(doc([{ id: 'v0', clips: [media('a', 0, 0, 3)] }], { fps: 15 }), /15 fps/);
    refuse(
      doc([
        {
          id: 'v0',
          clips: [colorClip({ id: 'k', startSec: 0, durationSec: 1, color: 'papayawhip' })],
        },
      ]),
      /"papayawhip".*#ffcc00/,
    );
    refuse(
      doc([
        { id: 'v0', clips: [media('a', 0, 0, 3)] },
        {
          id: 'captions',
          clips: [textClip({ id: 't', text: 'Late', startSec: 2, durationSec: 2 })],
        },
      ]),
      /past the end of the picture/,
    );
  });

  it('refuses text shorter than a frame', () => {
    refuse(
      doc([
        { id: 'v0', clips: [media('a', 0, 0, 3)] },
        {
          id: 'captions',
          clips: [textClip({ id: 'blip', text: 'Blip', startSec: 0, durationSec: 0.01 })],
        },
      ]),
      /"blip" is shorter than one frame/,
    );
  });

  it('refuses media it has no record of, or a clip past the end of its source', () => {
    refuse(doc([{ id: 'v0', clips: [media('a', 0, 0, 3)] }]), /No media registered/, new Map());
    refuse(doc([{ id: 'v0', clips: [media('a', 0, 50, 70)] }]), /source is 60s long/);
  });
});

describe('interchange — FCP7 XML (Premiere)', () => {
  it('writes a version 4 sequence with linked picture and stereo sound', () => {
    const out = exportAs(
      'xmeml',
      doc([{ id: 'v0', clips: [media('a', 0, 1, 6)] }], { fps: 29.97 }),
    );
    const root = parse(out.files[0]?.content ?? '');
    expect(root.tagName).toBe('xmeml');
    expect(root.getAttribute('version')).toBe('4');
    const sequenceRate = one(one(root, 'sequence'), 'rate');
    expect(text(sequenceRate, 'timebase')).toBe('30');
    expect(text(sequenceRate, 'ntsc')).toBe('TRUE');
    const video = one(root, 'video');
    const clip = one(one(video, 'track'), 'clipitem');
    expect(text(clip, 'start')).toBe('0');
    expect(text(clip, 'end')).toBe('150');
    expect(text(clip, 'in')).toBe('30');
    expect(text(clip, 'out')).toBe('180');
    expect(text(clip, 'pathurl')).toBe('file://localhost/footage/take%20one.mov');
    const audio = children(one(root, 'media')).find((e) => e.tagName === 'audio') as Element;
    const audioTracks = children(audio).filter((e) => e.tagName === 'track');
    expect(audioTracks).toHaveLength(2);
    expect(audioTracks.map((t) => text(one(t, 'sourcetrack'), 'trackindex'))).toEqual(['1', '2']);
    // Audio references the file the video clip defined.
    expect(one(audioTracks[0] as Element, 'file').getAttribute('id')).toBe(
      one(clip, 'file').getAttribute('id'),
    );
    expect(all(clip, 'link')).toHaveLength(3);
    expect(out.files).toHaveLength(1);
  });

  it('writes a centered transition and fades as transition items', () => {
    const root = parse(
      exportAs(
        'xmeml',
        doc([
          {
            id: 'v0',
            clips: [
              mediaClip({
                id: 'a',
                mediaId: A,
                startSec: 0,
                sourceOutSec: 5,
                effects: [{ type: 'fadeIn', durationSec: 0.5 }],
              }),
              media('b', 5, 10, 15, B),
            ],
            transitions: [{ afterClipId: 'a', durationSec: 1 }],
          },
        ]),
      ).files[0]?.content ?? '',
    );
    const track = one(one(root, 'video'), 'track');
    const items = children(track);
    expect(items.map((e) => e.tagName)).toEqual([
      'transitionitem',
      'clipitem',
      'transitionitem',
      'clipitem',
    ]);
    const [fade, a, cross, b] = items as Element[];
    expect(text(fade as Element, 'alignment')).toBe('start-black');
    expect([text(fade as Element, 'start'), text(fade as Element, 'end')]).toEqual(['0', '15']);
    expect(text(cross as Element, 'alignment')).toBe('center');
    expect([text(cross as Element, 'start'), text(cross as Element, 'end')]).toEqual([
      '120',
      '150',
    ]);
    // 15 frames at 30 fps, in Premiere ticks.
    expect(text(cross as Element, 'cutPointTicks')).toBe(String(15 * 8467200000));
    // Edges under transitions are placed by them, and in/out take in the
    // media under the blend: each clip's whole source range.
    expect([text(a as Element, 'start'), text(a as Element, 'end')]).toEqual(['-1', '-1']);
    expect([text(a as Element, 'in'), text(a as Element, 'out')]).toEqual(['0', '150']);
    expect([text(b as Element, 'start'), text(b as Element, 'end')]).toEqual(['-1', '270']);
    expect([text(b as Element, 'in'), text(b as Element, 'out')]).toEqual(['300', '450']);
    const audio = children(one(root, 'media')).find((e) => e.tagName === 'audio') as Element;
    const audioTransition = one(audio, 'transitionitem');
    expect(text(audioTransition, 'effectid')).toBe('KGAudioTransCrossFade0dB');
  });

  it('counts a source of another frame rate in its own frames', () => {
    const film = new Map([
      [
        A,
        source('/footage/a.mov', { video: { codec: 'h264', width: 1920, height: 1080, fps: 24 } }),
      ],
    ]);
    const root = parse(
      exportAs('xmeml', doc([{ id: 'v0', clips: [media('a', 0, 10, 12)] }]), film).files[0]
        ?.content ?? '',
    );
    const clip = one(one(one(root, 'video'), 'track'), 'clipitem');
    expect(text(one(clip, 'rate'), 'timebase')).toBe('24');
    expect([text(clip, 'start'), text(clip, 'end')]).toEqual(['0', '60']);
    expect([text(clip, 'in'), text(clip, 'out')]).toEqual(['240', '288']);
    expect(text(clip, 'duration')).toBe('1440');
  });

  it('times a title card cue through the transitions around it', () => {
    const out = exportAs(
      'xmeml',
      doc([
        {
          id: 'v0',
          clips: [
            textClip({ id: 'card', text: 'Chapter one', startSec: 0, durationSec: 5 }),
            media('a', 5, 0, 5),
          ],
          transitions: [{ afterClipId: 'card', durationSec: 1 }],
        },
      ]),
    );
    // The card shows to 5s in output, fading under the clip from 4s.
    expect(out.files[1]?.content).toBe('1\n00:00:00,000 --> 00:00:05,000\nChapter one\n');
  });

  it('writes text as SRT captions beside the XML, in output time', () => {
    const out = exportAs(
      'xmeml',
      doc([
        {
          id: 'v0',
          clips: [media('a', 0, 0, 5), media('b', 5, 0, 5, B)],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
        {
          id: 'captions',
          clips: [
            textClip({ id: 't1', text: 'First line', startSec: 0.5, durationSec: 1.3 }),
            textClip({ id: 't2', text: 'After the blend', startSec: 6, durationSec: 2 }),
          ],
        },
      ]),
    );
    expect(out.files.map((f) => f.path)).toEqual(['/out/My Cut.xml', '/out/My Cut.srt']);
    expect(out.files[1]?.content).toBe(
      '1\n00:00:00,500 --> 00:00:01,800\nFirst line\n\n2\n00:00:05,000 --> 00:00:07,000\nAfter the blend\n',
    );
    expect(out.notes.join(' ')).toMatch(/SRT/);
  });
});

describe('interchange — caption files and placement', () => {
  const captionTracks = (...ids: string[]): Composition =>
    doc([
      { id: 'v0', clips: [media('a', 0, 0, 5)] },
      ...ids.map((id, i) => ({
        id,
        clips: [textClip({ id: `t${i}`, text: `Line ${i}`, startSec: i, durationSec: 1 })],
      })),
    ]);

  it('names caption files from track ids it makes filename-safe and distinct', () => {
    const out = exportAs('xmeml', captionTracks('x/../../escape', 'a b', 'a/b'));
    expect(out.files.map((f) => f.path)).toEqual([
      '/out/My Cut.xml',
      '/out/My Cut.x_escape.srt',
      '/out/My Cut.a_b.srt',
      '/out/My Cut.a_b-2.srt',
    ]);
  });

  it('never names a caption file like the main output', () => {
    const out = buildInterchange(captionTracks('captions'), MEDIA, {
      format: 'xmeml',
      output: '/out/cut.SRT',
    });
    expect(out.files.map((f) => f.path)).toEqual(['/out/cut.SRT', '/out/cut-2.srt']);
  });

  it('reports the background color lost behind letterboxed clips', () => {
    const fourThree = new Map([
      [
        A,
        source('/footage/a.mov', { video: { codec: 'h264', width: 1440, height: 1080, fps: 30 } }),
      ],
    ]);
    const comp = (background: string): Composition =>
      doc([{ id: 'v0', clips: [media('a', 0, 0, 2)] }], { background });
    expect(exportAs('fcpxml', comp('navy'), fourThree).notes.join(' ')).toMatch(/black bars/);
    expect(exportAs('xmeml', comp('black'), fourThree).notes).toEqual([]);
  });

  it('vets every file it writes, caption files included, before writing any', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'interchange-confine-'));
    const comp = doc([
      { id: 'v0', clips: [textClip({ id: 'card', text: 'Title', startSec: 0, durationSec: 2 })] },
    ]);
    const output = join(dir, 'cut.xml');
    await expect(
      exportInterchange(comp, new Map(), {
        format: 'xmeml',
        output,
        confine: (path) => {
          if (path.endsWith('.srt')) throw new Error(`refused ${path}`);
          return path;
        },
      }),
    ).rejects.toThrow(/refused .*cut\.srt/);
    expect(existsSync(output)).toBe(false);
  });

  it('scales a source of another size to fit the Premiere canvas', () => {
    const root = parse(
      exportAs(
        'xmeml',
        doc([{ id: 'v0', clips: [media('a', 0, 0, 2), media('b', 2, 0, 2, B)] }]),
        new Map([
          [A, source('/footage/a.mov')],
          [
            B,
            source('/footage/b.mov', {
              video: { codec: 'h264', width: 1920, height: 1080, fps: 30 },
            }),
          ],
        ]),
      ).files[0]?.content ?? '',
    );
    const [a, b] = all(one(one(root, 'video'), 'track'), 'clipitem');
    expect(text(one(a as Element, 'filter'), 'effectid')).toBe('basic');
    expect(text(one(a as Element, 'filter'), 'value')).toBe('50');
    expect(all(b as Element, 'filter')).toHaveLength(0);
  });
});

describe('interchange — helpers', () => {
  it('names the format from the file extension', () => {
    expect(interchangeFormatFor('/x/cut.fcpxml')).toBe('fcpxml');
    expect(interchangeFormatFor('/x/cut.XML')).toBe('xmeml');
    expect(interchangeFormatFor('/x/cut.mp4')).toBeNull();
  });

  it('reads FFmpeg colors', () => {
    expect(parseColor('white')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor('black@0.6')).toEqual({ r: 0, g: 0, b: 0, a: 0.6 });
    expect(parseColor('0xff000080')?.a).toBeCloseTo(128 / 255);
    expect(parseColor('#FFCC00')).toEqual({ r: 1, g: 0.8, b: 0, a: 1 });
    expect(parseColor('papayawhip')).toBeNull();
  });

  it('reads camera timecode, drop-frame included', () => {
    expect(parseTimecode('    timecode        : 01:00:00;00\n')).toBe('01:00:00;00');
    expect(parseTimecode('no timecode here')).toBeNull();
    const ntsc30 = { num: 1001, den: 30000, timebase: 30, ntsc: true };
    expect(timecodeFrames('01:00:00:00', ntsc30)).toBe(108000);
    // Drop-frame skips 2 frame numbers in 54 of every 60 minutes.
    expect(timecodeFrames('01:00:00;00', ntsc30)).toBe(107892);
    expect(timecodeFrames('00:10:00;00', ntsc30)).toBe(17982);
  });
});

/**
 * Opt-in: validate a rich export against Apple's FCPXML 1.10 DTD with xmllint.
 * The DTD ships inside Final Cut Pro and isn't redistributable, so point
 * FCPXML_DTD at a copy (Final Cut Pro.app/Contents/Frameworks/Interchange.framework/
 * Versions/A/Resources/FCPXMLv1_10.dtd) to run it.
 */
describe.skipIf(!process.env.FCPXML_DTD)('interchange — FCPXML DTD', () => {
  it('validates against FCPXMLv1_10.dtd', async () => {
    const out = exportAs(
      'fcpxml',
      doc([
        {
          id: 'v0',
          clips: [
            colorClip({ id: 'k', startSec: 0, durationSec: 1 }),
            mediaClip({
              id: 'a',
              mediaId: A,
              startSec: 1,
              sourceOutSec: 4,
              effects: [
                { type: 'fadeIn', durationSec: 0.5 },
                { type: 'volume', gain: 1.5 },
              ],
            }),
            media('b', 5, 10, 15, B),
            colorClip({ id: 'r', startSec: 11, durationSec: 1, color: '#336699' }),
            textClip({ id: 'card', text: 'The end', startSec: 12, durationSec: 2 }),
          ],
          transitions: [{ afterClipId: 'a', durationSec: 1 }],
        },
        {
          id: 'captions',
          clips: [
            textClip({ id: 't1', text: 'Over the gap', startSec: 0.2, durationSec: 0.5 }),
            textClip({
              id: 't2',
              text: 'Across <the> blend',
              startSec: 4,
              durationSec: 2,
              style: { anchor: 'top-left' },
            }),
          ],
        },
      ]),
    );
    const dir = mkdtempSync(join(tmpdir(), 'fcpxml-dtd-'));
    const file = join(dir, 'cut.fcpxml');
    writeFileSync(file, out.files[0]?.content ?? '');
    const { exitCode, stderr } = await execa(
      'xmllint',
      ['--noout', '--dtdvalid', process.env.FCPXML_DTD as string, file],
      { reject: false },
    );
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });
});
