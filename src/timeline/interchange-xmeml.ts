import { pathToFileURL } from 'node:url';
import {
  channelCount,
  escapeXml,
  type FrameRate,
  type InterchangeMedia,
  type Layout,
  mediaName,
  type Rgba,
  type SpineItem,
  sourceRate,
  type TitleSpec,
  timecodeFrames,
  toFrames,
} from './interchange-layout.js';
import type { MediaId } from './schema.js';

/**
 * Write a layout as Final Cut Pro 7 XML (`xmeml` version 4) — the XML Premiere
 * Pro imports (File → Import), which DaVinci Resolve reads too. One video track
 * holds the picture, one or two audio tracks its sound, and transitions and
 * fades are transition items, laid out the way Premiere's own export writes them.
 *
 * Premiere drops the text generators this format has, so text goes to SRT
 * caption files instead (one per text track), which Premiere, Resolve and Final
 * Cut all import as captions.
 */

/** Premiere's time unit: ticks per second. */
const TICKS_PER_SECOND = 254016000000;

/** Frames of spare media given to a generated clip on each side, so a
 *  transition into or out of it has handles to blend with. */
const GENERATOR_HANDLE_SECONDS = 10;

function tag(name: string, value: string | number): string {
  return `<${name}>${typeof value === 'number' ? value : escapeXml(value)}</${name}>`;
}

function rateXml(rate: FrameRate): string {
  return `<rate>${tag('timebase', rate.timebase)}${tag('ntsc', rate.ntsc ? 'TRUE' : 'FALSE')}</rate>`;
}

function timecodeString(frames: number, rate: FrameRate): string {
  const ff = frames % rate.timebase;
  const totalSeconds = Math.floor(frames / rate.timebase);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(ff)}`;
}

function srtTime(frames: number, rate: FrameRate): string {
  const ms = Math.round((frames * rate.num * 1000) / rate.den);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)},${pad(ms % 1000, 3)}`;
}

/** 0..1 color channels as the 0–255 a Premiere color matte stores. */
function byte(v: number): number {
  return Math.round(v * 255);
}

type Alignment = 'center' | 'start-black' | 'end-black';

interface TransitionItem {
  start: number;
  end: number;
  alignment: Alignment;
  /** Frames from the start of the transition to the edit. */
  cutAt: number;
}

interface TrackEntry {
  /** Sort key: the item's output start frame. */
  at: number;
  xml: string;
}

export interface CaptionTrack {
  trackId: string;
  srt: string;
}

export interface XmemlResult {
  content: string;
  captions: CaptionTrack[];
  notes: string[];
}

export function writeXmeml(layout: Layout, sequenceName: string): XmemlResult {
  const { rate } = layout;
  const notes = new Set<string>();
  const ticksPerFrame = (TICKS_PER_SECOND * rate.num) / rate.den;
  const handle = Math.round((GENERATOR_HANDLE_SECONDS * rate.den) / rate.num);

  const audioChannels = (info: InterchangeMedia | undefined): number =>
    info?.audio ? channelCount(info.audio.channels) : 0;
  const mediaOf = (item: SpineItem): InterchangeMedia | undefined =>
    item.kind === 'media' ? layout.media.get(item.mediaId) : undefined;
  const audioTracks = Math.min(
    2,
    Math.max(0, ...[...layout.media.values()].map((info) => audioChannels(info))),
  );
  for (const info of layout.media.values()) {
    if (audioChannels(info) > 2) {
      notes.add(
        `Only the first 2 audio channels of ${mediaName(info.path)} are placed on the timeline.`,
      );
    }
  }

  /** Whether a spine item puts something on a track (0 = video, k = audio k). */
  const onTrack = (item: SpineItem, track: number): boolean => {
    if (item.kind === 'gap') return false;
    const info = mediaOf(item);
    if (track === 0) return item.kind !== 'media' || info?.video != null;
    return item.kind === 'media' && audioChannels(info) >= track;
  };

  // Transition and fade items per track, and the clip edges they cover.
  const transitionsOn = (track: number): TransitionItem[] => {
    const items: TransitionItem[] = [];
    for (const item of layout.spine) {
      if (!onTrack(item, track)) continue;
      if (item.fades.in > 0) {
        items.push({
          start: item.offset,
          end: item.offset + item.fades.in,
          alignment: 'start-black',
          cutAt: 0,
        });
      }
      if (item.fades.out > 0) {
        const end = item.offset + item.duration;
        items.push({
          start: end - item.fades.out,
          end,
          alignment: 'end-black',
          cutAt: item.fades.out,
        });
      }
    }
    for (const t of layout.transitions) {
      const a = layout.spine[t.afterIndex] as SpineItem;
      const b = layout.spine[t.afterIndex + 1] as SpineItem;
      if (onTrack(a, track) && onTrack(b, track)) {
        items.push({
          start: t.offset,
          end: t.offset + t.duration,
          alignment: 'center',
          cutAt: t.cut - t.offset,
        });
      } else if (onTrack(a, track) || onTrack(b, track)) {
        notes.add(
          `A transition between a clip with ${track === 0 ? 'picture' : 'sound'} and one without isn't carried on that track.`,
        );
      }
    }
    return items;
  };

  const transitionXml = (t: TransitionItem, track: number): string => {
    const effect =
      track === 0
        ? `<effect>${tag('name', 'Cross Dissolve')}${tag('effectid', 'Cross Dissolve')}${tag('effectcategory', 'Dissolve')}${tag('effecttype', 'transition')}${tag('mediatype', 'video')}${tag('wipecode', 0)}${tag('wipeaccuracy', 100)}${tag('startratio', 0)}${tag('endratio', 1)}${tag('reverse', 'FALSE')}</effect>`
        : `<effect>${tag('name', 'Cross Fade (0dB)')}${tag('effectid', 'KGAudioTransCrossFade0dB')}${tag('effecttype', 'transition')}${tag('mediatype', 'audio')}</effect>`;
    return (
      '<transitionitem>' +
      tag('start', t.start) +
      tag('end', t.end) +
      tag('alignment', t.alignment) +
      tag('cutPointTicks', Math.round(t.cutAt * ticksPerFrame)) +
      rateXml(rate) +
      effect +
      '</transitionitem>'
    );
  };

  // Ids: one clipitem id per (spine item, track), one file id per source.
  let clipCounter = 0;
  const clipIds = new Map<string, string>();
  const clipId = (index: number, track: number): string => {
    const key = `${index}:${track}`;
    let id = clipIds.get(key);
    if (!id) {
      id = `clipitem-${++clipCounter}`;
      clipIds.set(key, id);
    }
    return id;
  };
  const tracks = [0, ...Array.from({ length: audioTracks }, (_, i) => i + 1)];
  // 1-based position of each item among the clips on its track, for links.
  const clipIndex = new Map<string, number>();
  for (const track of tracks) {
    let n = 0;
    layout.spine.forEach((item, index) => {
      if (onTrack(item, track)) clipIndex.set(`${index}:${track}`, ++n);
    });
  }

  const fileIds = new Map<MediaId, string>();
  const defined = new Set<MediaId>();
  const fileXml = (mediaId: MediaId, info: InterchangeMedia): string => {
    let id = fileIds.get(mediaId);
    if (!id) {
      id = `file-${fileIds.size + 1}`;
      fileIds.set(mediaId, id);
    }
    if (defined.has(mediaId)) return `<file id="${id}"/>`;
    defined.add(mediaId);
    const srcRate = (info.video && sourceRate(info.video.fps)) || rate;
    const tcFrames = info.video && info.timecode ? timecodeFrames(info.timecode, srcRate) : null;
    const timecode = tcFrames
      ? `<timecode>${rateXml(srcRate)}${tag('string', info.timecode as string)}${tag('frame', tcFrames)}${tag('displayformat', /[;.]\d{2}$/.test(info.timecode as string) ? 'DF' : 'NDF')}</timecode>`
      : '';
    const video = info.video
      ? `<video><samplecharacteristics>${rateXml(srcRate)}${tag('width', info.video.width)}${tag('height', info.video.height)}${tag('anamorphic', 'FALSE')}${tag('pixelaspectratio', 'square')}${tag('fielddominance', 'none')}</samplecharacteristics></video>`
      : '';
    const audio = info.audio
      ? `<audio><samplecharacteristics>${tag('depth', 16)}${tag('samplerate', info.audio.sampleRate || 48000)}</samplecharacteristics>${tag('channelcount', audioChannels(info))}</audio>`
      : '';
    return (
      `<file id="${id}">` +
      tag('name', info.path.split(/[\\/]/).pop() ?? info.path) +
      tag('pathurl', `file://localhost${pathToFileURL(info.path).pathname}`) +
      rateXml(srcRate) +
      tag('duration', Math.ceil((info.durationSec * srcRate.den) / srcRate.num)) +
      timecode +
      `<media>${video}${audio}</media>` +
      '</file>'
    );
  };

  const linksXml = (index: number, item: SpineItem): string =>
    tracks
      .filter((track) => onTrack(item, track))
      .map(
        (track) =>
          '<link>' +
          tag('linkclipref', clipId(index, track)) +
          tag('mediatype', track === 0 ? 'video' : 'audio') +
          tag('trackindex', Math.max(1, track)) +
          tag('clipindex', clipIndex.get(`${index}:${track}`) ?? 1) +
          (track === 0 ? '' : tag('groupindex', 1)) +
          '</link>',
      )
      .join('');

  /** Premiere places a clip at 100% whatever its size; scale it to fit the
   *  canvas, keeping its aspect, as the mp4 export does. */
  const fitScale = (info: InterchangeMedia): string => {
    if (!info.video) return '';
    const { width, height } = info.video;
    if (width === layout.width && height === layout.height) return '';
    const scale = Math.round(Math.min(layout.width / width, layout.height / height) * 1e6) / 1e4;
    return `<filter><effect>${tag('name', 'Basic Motion')}${tag('effectid', 'basic')}${tag('effectcategory', 'motion')}${tag('effecttype', 'motion')}${tag('mediatype', 'video')}<parameter authoringApp="PremierePro">${tag('parameterid', 'scale')}${tag('name', 'Scale')}${tag('valuemin', 0)}${tag('valuemax', 1000)}${tag('value', scale)}</parameter></effect></filter>`;
  };

  const audioLevels = (gain: number): string =>
    gain === 1
      ? ''
      : `<filter><effect>${tag('name', 'Audio Levels')}${tag('effectid', 'audiolevels')}${tag('effectcategory', 'audiolevels')}${tag('effecttype', 'audiolevels')}${tag('mediatype', 'audio')}<parameter>${tag('parameterid', 'level')}${tag('name', 'Level')}${tag('valuemin', 0)}${tag('valuemax', 3.98109)}${tag('value', gain)}</parameter></effect></filter>`;

  const matteXml = (color: Rgba): string =>
    `<effect>${tag('name', 'Color')}${tag('effectid', 'Color')}${tag('effectcategory', 'Matte')}${tag('effecttype', 'generator')}${tag('mediatype', 'video')}<parameter authoringApp="PremierePro">${tag('parameterid', 'fillcolor')}${tag('name', 'Color')}<value>${tag('alpha', 255)}${tag('red', byte(color.r))}${tag('green', byte(color.g))}${tag('blue', byte(color.b))}</value></parameter></effect>`;

  const trackXml = (track: number): string => {
    const transitions = transitionsOn(track);
    // A clip edge under a transition is written as -1: the transition places it.
    // Across a centered transition the clip's in/out also take in the media
    // under it, past the edit: `reach` is how far, in sequence frames.
    const startCovered = new Set<number>();
    const endCovered = new Set<number>();
    const reachBefore = new Map<number, number>();
    const reachAfter = new Map<number, number>();
    for (const t of transitions) {
      const cut = t.start + t.cutAt;
      if (t.alignment !== 'end-black') startCovered.add(cut);
      if (t.alignment !== 'start-black') endCovered.add(cut);
      if (t.alignment === 'center') {
        reachBefore.set(cut, cut - t.start);
        reachAfter.set(cut, t.end - cut);
      }
    }
    const entries: TrackEntry[] = transitions.map((t) => ({
      at: t.start,
      xml: transitionXml(t, track),
    }));

    layout.spine.forEach((item, index) => {
      if (!onTrack(item, track)) return;
      const end = item.offset + item.duration;
      const start = startCovered.has(item.offset) ? -1 : item.offset;
      const stop = endCovered.has(end) ? -1 : end;
      const timing = `${tag('start', start)}${tag('end', stop)}`;
      const head = reachBefore.get(item.offset) ?? 0;
      const tail = reachAfter.get(end) ?? 0;
      const id = clipId(index, track);
      if (item.kind === 'media') {
        const info = layout.media.get(item.mediaId) as InterchangeMedia;
        // A media clip counts its source in the source's own frames; only
        // start/end are sequence frames.
        const srcRate = (info.video && sourceRate(info.video.fps)) || rate;
        const toSource = (frames: number): number =>
          Math.round((frames * rate.num * srcRate.den) / (rate.den * srcRate.num));
        const sourceIn = toFrames(item.sourceInSec, srcRate);
        entries.push({
          at: item.offset,
          xml:
            `<clipitem id="${id}">` +
            tag('name', mediaName(info.path)) +
            tag('enabled', 'TRUE') +
            tag('duration', Math.ceil((info.durationSec * srcRate.den) / srcRate.num)) +
            rateXml(srcRate) +
            timing +
            tag('in', sourceIn + toSource(item.head - head)) +
            tag('out', sourceIn + toSource(item.head + item.duration + tail)) +
            fileXml(item.mediaId, info) +
            (track === 0
              ? fitScale(info)
              : `<sourcetrack>${tag('mediatype', 'audio')}${tag('trackindex', track)}</sourcetrack>${audioLevels(item.gain)}`) +
            linksXml(index, item) +
            '</clipitem>',
        });
        return;
      }
      const isTitle = item.kind === 'title';
      const color = item.kind === 'color' ? item.color : layout.background;
      if (isTitle) {
        notes.add(
          'Text clips on the picture track become a background-color matte; their words are in the SRT captions.',
        );
      }
      entries.push({
        at: item.offset,
        xml:
          `<generatoritem id="${id}">` +
          tag('name', isTitle ? 'Title background' : 'Color') +
          tag('enabled', 'TRUE') +
          tag('duration', item.duration + 2 * handle) +
          rateXml(rate) +
          timing +
          tag('in', handle - head) +
          tag('out', handle + item.duration + tail) +
          matteXml(color) +
          '</generatoritem>',
      });
    });

    entries.sort((a, b) => a.at - b.at);
    return `<track>${entries.map((e) => e.xml).join('')}</track>`;
  };

  // Video first, so each source's full <file> definition comes before its references.
  const videoTrack = trackXml(0);
  const audioTrackXml = tracks.slice(1).map((track) => trackXml(track));

  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    '<sequence id="sequence-1">',
    tag('name', sequenceName),
    tag('duration', layout.duration),
    rateXml(rate),
    `<timecode>${rateXml(rate)}${tag('string', timecodeString(0, rate))}${tag('frame', 0)}${tag('displayformat', 'NDF')}</timecode>`,
    '<media>',
    '<video>',
    `<format><samplecharacteristics>${rateXml(rate)}${tag('width', layout.width)}${tag('height', layout.height)}${tag('anamorphic', 'FALSE')}${tag('pixelaspectratio', 'square')}${tag('fielddominance', 'none')}</samplecharacteristics></format>`,
    videoTrack,
    '</video>',
    '<audio>',
    tag('numOutputChannels', 2),
    `<format><samplecharacteristics>${tag('depth', 16)}${tag('samplerate', 48000)}</samplecharacteristics></format>`,
    ...audioTrackXml,
    '</audio>',
    '</media>',
    '</sequence>',
    '</xmeml>',
    '',
  ].join('\n');

  // Captions: every text clip, grouped by the track it came from.
  const byTrack = new Map<string, Array<{ offset: number; duration: number; title: TitleSpec }>>();
  layout.spine.forEach((item, index) => {
    if (item.kind !== 'title') return;
    // A title card's words show through the transitions around it, not just
    // between the edits.
    const before = layout.transitions.find((t) => t.afterIndex === index - 1);
    const after = layout.transitions.find((t) => t.afterIndex === index);
    const start = before ? before.offset : item.offset;
    const end = after ? after.offset + after.duration : item.offset + item.duration;
    const list = byTrack.get(item.title.trackId) ?? [];
    list.push({ offset: start, duration: end - start, title: item.title });
    byTrack.set(item.title.trackId, list);
  });
  for (const title of layout.titles) {
    const list = byTrack.get(title.trackId) ?? [];
    list.push({ offset: title.offset, duration: title.duration, title });
    byTrack.set(title.trackId, list);
  }
  const captions: CaptionTrack[] = [...byTrack].map(([trackId, cues]) => ({
    trackId,
    srt: cues
      .sort((a, b) => a.offset - b.offset)
      .map(
        (cue, i) =>
          `${i + 1}\n${srtTime(cue.offset, rate)} --> ${srtTime(cue.offset + cue.duration, rate)}\n` +
          `${cue.title.text
            .replace(/\r\n?/g, '\n')
            .replace(/\n{2,}/g, '\n')
            .trim()}\n`,
      )
      .join('\n'),
  }));
  if (captions.length > 0) {
    notes.add(
      'Text is written as SRT captions next to the XML (words and timing only — not color, size, position or background). ' +
        'Import the .srt into the editor and put it on a caption or subtitle track.',
    );
  }
  if (layout.transitions.some((t) => t.kind === 'dissolve')) {
    notes.add(
      'A "dissolve" transition is written as a cross dissolve; the mp4 export draws a pixel dissolve.',
    );
  }

  return { content, captions, notes: [...notes] };
}
