import { pathToFileURL } from 'node:url';
import {
  addTime,
  attrs,
  channelCount,
  escapeXml,
  type Fades,
  type FrameRate,
  formatTime,
  framesTime,
  type InterchangeMedia,
  type LaidTitle,
  type Layout,
  mediaName,
  type Rational,
  type Rgba,
  type SpineItem,
  sourceRate,
  type TitleSpec,
  timecodeFrames,
  toFrames,
} from './interchange-layout.js';
import type { MediaId } from './schema.js';

/**
 * Write a layout as FCPXML 1.10 — the version Final Cut Pro 10.6+ and DaVinci
 * Resolve 18+ both import. One library → event → project, the picture track as
 * the primary storyline, and text over it as Basic Title clips connected on
 * lanes above. Element names, effect ids and parameter keys are the ones Final
 * Cut writes itself, and so is the transition layout: Final Cut's own exports
 * keep the spine's clips end to end (each offset is the previous one's end) and
 * start a transition about half its length before the edit, reaching into the
 * media past each clip's range rather than shortening the spine.
 */

const VERSION = '1.10';

const CROSS_DISSOLVE = {
  name: 'Cross Dissolve',
  uid: 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
};
const AUDIO_CROSSFADE = { name: 'Audio Crossfade', uid: 'FFAudioTransition' };
const BASIC_TITLE = {
  name: 'Basic Title',
  uid: '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti',
};
const SOLID = {
  name: 'Custom',
  uid: '.../Generators.localized/Solids.localized/Custom.localized/Custom.motn',
};
const SOLID_COLOR_KEY = '9999/10008/10006/2/1/1';
const TITLE_POSITION_KEY = '9999/999166631/999166633/1/100/101';
const TITLE_ALIGNMENT_KEY = '9999/999166631/999166633/2/354/999169573/401';

/** Local start Final Cut gives generated clips (titles, solids, gaps). */
const GENERATOR_START: Rational = { n: 3600, d: 1 };

/** Inset (px) of anchored text from the frame edge, as the mp4 export draws it. */
const EDGE = 40;

interface Asset {
  id: string;
  formatId?: string;
  /** The rate the source's frames are counted in. */
  rate: FrameRate;
  /** Source time of the file's first frame (its start timecode). */
  start: Rational;
  info: InterchangeMedia;
}

class IdPool {
  private next = 1;
  take(): string {
    return `r${this.next++}`;
  }
}

function num(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

function rgb(c: Rgba): string {
  return `${num(c.r)} ${num(c.g)} ${num(c.b)}`;
}

function gainDb(gain: number): string {
  // Final Cut's floor is -96 dB; silence (gain 0) clamps there.
  const db = gain <= 0 ? -96 : Math.max(-96, 20 * Math.log10(gain));
  return `${num(db)}dB`;
}

function fadeParam(fades: Fades, rate: FrameRate): string {
  const parts: string[] = [];
  if (fades.in > 0) {
    parts.push(
      `<fadeIn${attrs({ type: 'linear', duration: formatTime(framesTime(fades.in, rate)) })}/>`,
    );
  }
  if (fades.out > 0) {
    parts.push(
      `<fadeOut${attrs({ type: 'linear', duration: formatTime(framesTime(fades.out, rate)) })}/>`,
    );
  }
  return parts.length ? `<param name="amount">${parts.join('')}</param>` : '';
}

/** Where Basic Title puts text for an anchor: pixels from frame center, y up. */
function titlePlacement(
  title: TitleSpec,
  width: number,
  height: number,
): { position: string; alignment: 'left' | 'center' | 'right' } {
  const { anchor, fontSize } = title.style;
  const alignment = anchor.endsWith('left')
    ? 'left'
    : anchor.endsWith('right')
      ? 'right'
      : 'center';
  const x =
    alignment === 'left' ? -(width / 2 - EDGE) : alignment === 'right' ? width / 2 - EDGE : 0;
  const rowOffset = height / 2 - EDGE - fontSize / 2;
  const y = anchor.startsWith('top') ? rowOffset : anchor.startsWith('bottom') ? -rowOffset : 0;
  return { position: `${num(x)} ${num(y)}`, alignment };
}

export interface FcpxmlResult {
  content: string;
  notes: string[];
}

export function writeFcpxml(layout: Layout, projectName: string): FcpxmlResult {
  const { rate } = layout;
  const ids = new IdPool();
  const resources: string[] = [];
  const notes = new Set<string>();
  const time = (frames: number): string => formatTime(framesTime(frames, rate));

  const sequenceFormat = ids.take();
  resources.push(
    `<format${attrs({ id: sequenceFormat, frameDuration: formatTime(framesTime(1, rate)), width: layout.width, height: layout.height })}/>`,
  );

  // One format per distinct source picture, one asset per source.
  const formats = new Map<string, string>();
  const assets = new Map<MediaId, Asset>();
  for (const [mediaId, info] of layout.media) {
    const srcRate = info.video ? sourceRate(info.video.fps) : null;
    let formatId: string | undefined;
    if (info.video) {
      const frameDuration = formatTime(framesTime(1, srcRate ?? rate));
      const key = `${info.video.width}x${info.video.height}@${frameDuration}`;
      formatId = formats.get(key);
      if (!formatId) {
        formatId = ids.take();
        formats.set(key, formatId);
        resources.push(
          `<format${attrs({ id: formatId, frameDuration, width: info.video.width, height: info.video.height })}/>`,
        );
      }
    }
    const tcFrames = srcRate && info.timecode ? timecodeFrames(info.timecode, srcRate) : null;
    const start = tcFrames && srcRate ? framesTime(tcFrames, srcRate) : { n: 0, d: 1 };
    const durRate = srcRate ?? rate;
    const durFrames = Math.ceil((info.durationSec * durRate.den) / durRate.num);
    const id = ids.take();
    assets.set(mediaId, { id, formatId, rate: durRate, start, info });
    resources.push(
      `<asset${attrs({
        id,
        name: mediaName(info.path),
        start: formatTime(start),
        duration: formatTime(framesTime(durFrames, durRate)),
        hasVideo: info.video ? 1 : 0,
        format: formatId,
        hasAudio: info.audio ? 1 : 0,
        audioSources: info.audio ? 1 : undefined,
        audioChannels: info.audio ? channelCount(info.audio.channels) : undefined,
        audioRate: info.audio?.sampleRate || undefined,
      })}>` +
        `<media-rep${attrs({ kind: 'original-media', src: pathToFileURL(info.path).href })}/>` +
        '</asset>',
    );
  }

  const effect = (spec: { name: string; uid: string }): (() => string) => {
    let id: string | undefined;
    return () => {
      if (!id) {
        id = ids.take();
        resources.push(`<effect${attrs({ id, name: spec.name, uid: spec.uid })}/>`);
      }
      return id;
    };
  };
  const crossDissolve = effect(CROSS_DISSOLVE);
  const audioCrossfade = effect(AUDIO_CROSSFADE);
  const basicTitle = effect(BASIC_TITLE);
  const solid = effect(SOLID);

  let styleCount = 0;
  const titleBody = (title: TitleSpec): string => {
    const { position, alignment } = titlePlacement(title, layout.width, layout.height);
    const styleId = `ts${++styleCount}`;
    if (title.style.background) {
      notes.add(
        "Text background boxes aren't carried: Basic Title has no box, so captions and titles show without theirs. Add one in the editor.",
      );
    }
    return (
      `<param${attrs({ name: 'Position', key: TITLE_POSITION_KEY, value: position })}/>` +
      `<param${attrs({ name: 'Alignment', key: TITLE_ALIGNMENT_KEY, value: alignment === 'left' ? '0 (Left)' : alignment === 'right' ? '2 (Right)' : '1 (Center)' })}/>` +
      `<text><text-style${attrs({ ref: styleId })}>${escapeXml(title.text)}</text-style></text>` +
      `<text-style-def${attrs({ id: styleId })}><text-style${attrs({
        font: 'Helvetica',
        fontSize: title.style.fontSize,
        fontColor: `${rgb(title.color)} ${num(title.color.a)}`,
        alignment,
      })}/></text-style-def>`
    );
  };
  const titleName = (text: string): string =>
    text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text;

  // Connected titles go on the spine item their first frame falls in.
  const anchored = new Map<number, LaidTitle[]>();
  for (const title of layout.titles) {
    const host = layout.spine.findIndex(
      (item) => title.offset >= item.offset && title.offset < item.offset + item.duration,
    );
    if (host === -1) throw new Error(`Title for "${title.clipId}" starts outside the timeline.`);
    const list = anchored.get(host) ?? [];
    list.push(title);
    anchored.set(host, list);
  }

  const connected = (index: number, item: SpineItem, localStart: Rational): string =>
    (anchored.get(index) ?? [])
      .map(
        (title) =>
          `<title${attrs({
            ref: basicTitle(),
            lane: title.lane,
            offset: formatTime(addTime(localStart, framesTime(title.offset - item.offset, rate))),
            name: titleName(title.text),
            start: formatTime(GENERATOR_START),
            duration: time(title.duration),
          })}>${titleBody(title)}${blend(title.fades)}</title>`,
      )
      .join('');

  const blend = (fades: Fades): string => {
    const param = fadeParam(fades, rate);
    return param ? `<adjust-blend>${param}</adjust-blend>` : '';
  };

  const spineItem = (item: SpineItem, index: number): string => {
    const timing = { offset: time(item.offset), duration: time(item.duration) };
    switch (item.kind) {
      case 'media': {
        const asset = assets.get(item.mediaId) as Asset;
        // The in-point on a source frame, then any head hidden under a transition.
        const start = addTime(
          addTime(asset.start, framesTime(toFrames(item.sourceInSec, asset.rate), asset.rate)),
          framesTime(item.head, rate),
        );
        const volume = asset.info.audio
          ? (() => {
              const param = fadeParam(item.fades, rate);
              const amount = item.gain === 1 ? undefined : gainDb(item.gain);
              return param || amount
                ? `<adjust-volume${attrs({ amount })}>${param}</adjust-volume>`
                : '';
            })()
          : '';
        return (
          `<asset-clip${attrs({
            ref: asset.id,
            offset: timing.offset,
            name: mediaName(asset.info.path),
            start: formatTime(start),
            duration: timing.duration,
            format: asset.formatId,
          })}>` +
          (asset.info.video ? blend(item.fades) : '') +
          volume +
          connected(index, item, start) +
          '</asset-clip>'
        );
      }
      case 'color':
        // Black is a gap: it plays black everywhere, and Resolve reads gaps
        // more reliably than Final Cut's solid generator.
        if (item.color.r + item.color.g + item.color.b === 0) {
          return (
            `<gap${attrs({ name: 'Black', ...timing, start: formatTime(GENERATOR_START) })}>` +
            connected(index, item, GENERATOR_START) +
            '</gap>'
          );
        }
        return (
          `<video${attrs({ ref: solid(), ...timing, name: 'Color', start: formatTime(GENERATOR_START) })}>` +
          `<param${attrs({ name: 'Color', key: SOLID_COLOR_KEY, value: rgb(item.color) })}/>` +
          blend(item.fades) +
          connected(index, item, GENERATOR_START) +
          '</video>'
        );
      case 'title':
        if (layout.background.r + layout.background.g + layout.background.b > 0) {
          notes.add(
            "Text clips on the picture track show over black in the editor; the timeline's background color isn't carried.",
          );
        }
        return (
          `<title${attrs({ ref: basicTitle(), ...timing, name: titleName(item.title.text), start: formatTime(GENERATOR_START) })}>` +
          titleBody(item.title) +
          blend(item.fades) +
          connected(index, item, GENERATOR_START) +
          '</title>'
        );
      case 'gap':
        return (
          `<gap${attrs({ name: 'Gap', ...timing, start: formatTime(GENERATOR_START) })}>` +
          connected(index, item, GENERATOR_START) +
          '</gap>'
        );
    }
  };

  const transitionAfter = new Map(layout.transitions.map((t) => [t.afterIndex, t]));
  const spine: string[] = [];
  layout.spine.forEach((item, index) => {
    spine.push(spineItem(item, index));
    const t = transitionAfter.get(index);
    if (!t) return;
    if (t.kind === 'dissolve') {
      notes.add(
        'A "dissolve" transition is written as a cross dissolve; the mp4 export draws a pixel dissolve.',
      );
    }
    spine.push(
      `<transition${attrs({ name: CROSS_DISSOLVE.name, offset: time(t.offset), duration: time(t.duration) })}>` +
        `<filter-video${attrs({ ref: crossDissolve(), name: CROSS_DISSOLVE.name })}/>` +
        `<filter-audio${attrs({ ref: audioCrossfade(), name: AUDIO_CROSSFADE.name })}/>` +
        '</transition>',
    );
  });

  const sequence =
    `<sequence${attrs({ format: sequenceFormat, duration: time(layout.duration), tcStart: '0s', tcFormat: 'NDF', audioLayout: 'stereo', audioRate: '48k' })}>` +
    `<spine>\n${spine.join('\n')}\n</spine>` +
    '</sequence>';

  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    `<fcpxml version="${VERSION}">`,
    `<resources>\n${resources.join('\n')}\n</resources>`,
    `<library><event name="MakeMyClip"><project${attrs({ name: projectName })}>${sequence}</project></event></library>`,
    '</fcpxml>',
    '',
  ].join('\n');
  return { content, notes: [...notes] };
}
