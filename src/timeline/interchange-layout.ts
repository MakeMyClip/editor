import { videoLayers } from './compile.js';
import {
  type Clip,
  type Composition,
  clipEndSec,
  type TextClip,
  type TextStyle,
  type Track,
  type TransitionKind,
} from './composition.js';
import type { MediaId, MediaRef } from './schema.js';

/**
 * The format-neutral middle of an interchange export: the document checked for
 * what an editor's timeline can hold, then laid out in whole frames of the
 * sequence rate, in OUTPUT time — the timeline the mp4 export renders.
 *
 * Output time differs from document time in one way: the mp4 export blends a
 * transition by overlapping the two clips (A plays to its out-point while B
 * fades in over A's last `d` seconds), so every transition shortens what
 * follows by `d`. Editors keep clips end to end instead and center the
 * transition on the edit, reaching into media past each clip's in/out point.
 * The layout puts the edit `ceil(d/2)` frames into the overlap: A's visible
 * part ends `floor(d/2)` early and B starts `ceil(d/2)` late, so the editor
 * plays the same frames at the same times as the mp4.
 *
 * Text drawn over the picture follows the clip it sits on, as the mp4 export
 * burns it per clip, and becomes one title per stretch of output time.
 */

export class InterchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterchangeError';
  }
}

/** A source as an interchange file describes it: the ingest probe plus the
 *  camera start timecode, which editors match media by. */
export interface InterchangeMedia extends MediaRef {
  timecode?: string | null;
}

/** A frame rate as a frame duration of `num/den` seconds. */
export interface FrameRate {
  num: number;
  den: number;
  /** Whole-number rate an editor counts timecode in (30 for 29.97). */
  timebase: number;
  /** Whether the real rate is `timebase × 1000/1001`. */
  ntsc: boolean;
}

/** Project rates Final Cut Pro, Resolve and Premiere all offer. */
const PROJECT_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;
const NTSC_BASES = [24, 30, 48, 60, 120];
const WHOLE_RATES = [24, 25, 30, 48, 50, 60, 100, 120];

/** The standard rate `fps` names (29.97 → 30000/1001), or null for any other. */
export function standardRate(fps: number): FrameRate | null {
  for (const base of NTSC_BASES) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.005) {
      return { num: 1001, den: base * 1000, timebase: base, ntsc: true };
    }
  }
  const whole = Math.round(fps);
  if (Math.abs(fps - whole) < 1e-6 && WHOLE_RATES.includes(whole)) {
    return { num: 1, den: whole, timebase: whole, ntsc: false };
  }
  return null;
}

/** A source's rate: a standard one when it is close, else its whole-number
 *  rounding (phones record variable rates near 30). Null for no video rate. */
export function sourceRate(fps: number): FrameRate | null {
  if (!(fps > 0)) return null;
  const standard = standardRate(fps);
  if (standard) return standard;
  const whole = Math.max(1, Math.round(fps));
  return { num: 1, den: whole, timebase: whole, ntsc: false };
}

/** Seconds → whole frames at `rate`. */
export function toFrames(sec: number, rate: FrameRate): number {
  return Math.round((sec * rate.den) / rate.num);
}

// ─── Rational seconds ("1001/30000s"), as FCPXML writes time ────────────────

export interface Rational {
  n: number;
  d: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/** `frames` frames at `rate`, as rational seconds. */
export function framesTime(frames: number, rate: FrameRate): Rational {
  return { n: frames * rate.num, d: rate.den };
}

export function addTime(a: Rational, b: Rational): Rational {
  const d = (a.d / gcd(a.d, b.d)) * b.d;
  const n = a.n * (d / a.d) + b.n * (d / b.d);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) {
    throw new InterchangeError('A time in the timeline is too large to write exactly.');
  }
  return { n, d };
}

/** FCPXML time: reduced `n/ds`, or `ns` when whole. */
export function formatTime(t: Rational): string {
  const g = gcd(t.n, t.d);
  const n = t.n / g;
  const d = t.d / g;
  return d === 1 ? `${n}s` : `${n}/${d}s`;
}

/**
 * Frames since midnight that a camera timecode names, counted at `rate`.
 * `;` or `.` before the frames marks drop-frame, which skips frame numbers 0–1
 * (0–3 at 59.94) at every minute but each tenth.
 */
export function timecodeFrames(timecode: string, rate: FrameRate): number | null {
  const m = timecode.match(/^(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2})$/);
  if (!m) return null;
  const [hh, mm, ss, ff] = [m[1], m[2], m[3], m[5]].map(Number) as [number, number, number, number];
  const base = rate.timebase;
  let frames = ((hh * 60 + mm) * 60 + ss) * base + ff;
  if (m[4] !== ':' && rate.ntsc && base % 30 === 0) {
    const drop = (base / 30) * 2;
    const minutes = hh * 60 + mm;
    frames -= drop * (minutes - Math.floor(minutes / 10));
  }
  return frames;
}

// ─── Colors (FFmpeg color strings → RGBA in 0..1) ────────────────────────────

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED_COLORS: Record<string, string> = {
  white: 'ffffff',
  black: '000000',
  red: 'ff0000',
  green: '008000',
  lime: '00ff00',
  blue: '0000ff',
  yellow: 'ffff00',
  cyan: '00ffff',
  aqua: '00ffff',
  magenta: 'ff00ff',
  fuchsia: 'ff00ff',
  gray: '808080',
  grey: '808080',
  silver: 'c0c0c0',
  orange: 'ffa500',
  purple: '800080',
  pink: 'ffc0cb',
  brown: 'a52a2a',
  navy: '000080',
  teal: '008080',
  maroon: '800000',
  olive: '808000',
  gold: 'ffd700',
};

/** An FFmpeg color (`white`, `#ffcc00`, `0xffcc0080`, `black@0.6`) as RGBA, or
 *  null when it isn't one of the names or forms this export reads. */
export function parseColor(input: string): Rgba | null {
  const [rawName = '', rawAlpha] = input.trim().toLowerCase().split('@');
  const hex =
    NAMED_COLORS[rawName] ?? rawName.match(/^(?:#|0x)?([0-9a-f]{6}(?:[0-9a-f]{2})?)$/)?.[1];
  if (!hex) return null;
  const channel = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
  let a = hex.length === 8 ? channel(6) : 1;
  if (rawAlpha !== undefined) {
    const alpha = rawAlpha.startsWith('0x')
      ? Number.parseInt(rawAlpha.slice(2), 16) / 255
      : Number(rawAlpha);
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
    a = alpha;
  }
  return { r: channel(0), g: channel(2), b: channel(4), a };
}

// ─── The layout ──────────────────────────────────────────────────────────────

/** Fade lengths in frames on a clip's visible part (0 for none). */
export interface Fades {
  in: number;
  out: number;
}

/** A text clip's words and look, wherever it sits. */
export interface TitleSpec {
  clipId: string;
  trackId: string;
  text: string;
  style: TextStyle;
  color: Rgba;
}

interface SpineBase {
  /** Output frame the item starts at, and its visible length in frames. */
  offset: number;
  duration: number;
  fades: Fades;
}

/** One item of the main (picture) track, end to end with the next. */
export type SpineItem =
  | (SpineBase & {
      kind: 'media';
      clipId: string;
      mediaId: MediaId;
      /** The clip's in-point in its source, in seconds from the start of the
       *  media file (not its timecode), kept exact so writers can count it in
       *  the source's own frames. */
      sourceInSec: number;
      /** Sequence frames hidden at the head under a transition: the first
       *  visible frame is `head` frames past the in-point. */
      head: number;
      /** Product of the clip's volume effects (1 = unchanged). */
      gain: number;
    })
  | (SpineBase & { kind: 'color'; clipId: string; color: Rgba })
  | (SpineBase & { kind: 'title'; title: TitleSpec })
  | (SpineBase & { kind: 'gap' });

/** A blend between spine item `afterIndex` and the next one. */
export interface LaidTransition {
  afterIndex: number;
  kind: TransitionKind;
  /** Output frames: start of the blend, its length, and the edit inside it. */
  offset: number;
  duration: number;
  cut: number;
}

/** Text over the picture: one stretch of output time on lane ≥ 1. Where a
 *  transition overlaps two titles of a track, they cross-fade, as in the mp4. */
export interface LaidTitle extends TitleSpec {
  lane: number;
  offset: number;
  duration: number;
  fades: Fades;
}

export interface Layout {
  rate: FrameRate;
  width: number;
  height: number;
  background: Rgba;
  /** Total length in frames. */
  duration: number;
  spine: SpineItem[];
  transitions: LaidTransition[];
  titles: LaidTitle[];
  /** The sources the spine uses, by id. */
  media: Map<MediaId, InterchangeMedia>;
}

/** Transitions an editor's cross dissolve reproduces; the rest are refused. */
const CARRIED_TRANSITIONS: ReadonlySet<TransitionKind> = new Set(['fade', 'dissolve']);

/** Tolerance (seconds) for abutting clips, as in the export compiler. */
const ABUT_EPSILON = 1e-4;

function isIdentityTransform(clip: Clip): boolean {
  const t = clip.transform;
  if (!t) return true;
  return t.scale === 1 && t.x === 0.5 && t.y === 0.5 && t.rotationDeg === 0 && t.opacity === 1;
}

/** Refuse a clip whose effects or placement an interchange file can't carry. */
function assertCarried(clip: Clip): void {
  if (!isIdentityTransform(clip)) {
    throw new InterchangeError(
      `Clip "${clip.id}" has a transform (scale, position, rotation or opacity), which interchange export doesn't carry yet. ` +
        'Reset the transform, or export an mp4 instead.',
    );
  }
  for (const effect of clip.effects) {
    if (effect.type === 'speed') {
      throw new InterchangeError(
        `Clip "${clip.id}" has a speed effect, which interchange export doesn't carry yet. ` +
          'Remove it and retime the clip in the editor, or export an mp4 instead.',
      );
    }
    if (effect.type === 'adjust') {
      throw new InterchangeError(
        `Clip "${clip.id}" has a color adjustment, which interchange export doesn't carry. ` +
          'Remove it and grade the clip in the editor, or export an mp4 instead.',
      );
    }
    if (effect.type === 'chromaKey') {
      throw new InterchangeError(
        `Clip "${clip.id}" uses chromaKey, which interchange export doesn't carry. ` +
          'Remove it and key the clip in the editor, or export an mp4 instead.',
      );
    }
  }
}

function colorOf(value: string, what: string): Rgba {
  const color = parseColor(value);
  if (!color) {
    throw new InterchangeError(
      `${what} is "${value}", a color interchange export can't read. ` +
        'Use a hex color like #ffcc00 (optionally @0.5 for opacity) or a basic name like white.',
    );
  }
  return color;
}

function titleSpec(clip: TextClip, trackId: string): TitleSpec {
  return {
    clipId: clip.id,
    trackId,
    text: clip.text,
    style: clip.style,
    color: colorOf(clip.style.color, `Text clip "${clip.id}" color`),
  };
}

/** Pick the picture track and the text tracks over it, refusing what an
 *  editor's single storyline plus title lanes can't hold. */
function selectTracks(comp: Composition): { picture: Track; overlays: Track[] } {
  if (comp.tracks.some((t) => t.kind === 'audio' && t.clips.length > 0)) {
    throw new InterchangeError(
      "Separate audio tracks aren't supported in interchange export yet — audio comes from the video clips. " +
        'Remove the audio track, or export an mp4 instead.',
    );
  }
  if (!comp.tracks.some((t) => t.kind === 'video' && t.clips.length > 0)) {
    throw new InterchangeError('Nothing to export: no video track has clips.');
  }
  const { picture, overlays } = videoLayers(comp);
  if (!picture) {
    throw new InterchangeError(
      'Interchange export holds one picture track with text above it; this timeline has media or color on more than one track. Move them onto one track.',
    );
  }
  const pictureIndex = comp.tracks.indexOf(picture);
  for (const overlay of overlays) {
    if (comp.tracks.indexOf(overlay) < pictureIndex) {
      throw new InterchangeError(
        `Text track "${overlay.id}" is under track "${picture.id}", so the picture would hide it. Put the text on a track above it.`,
      );
    }
    if (overlay.transitions.length > 0) {
      throw new InterchangeError(
        `Text track "${overlay.id}" has transitions, which export can't put on text over video yet. Remove them.`,
      );
    }
    const withEffects = overlay.clips.find((c) => c.effects.length > 0);
    if (withEffects) {
      throw new InterchangeError(
        `Text clip "${withEffects.id}" over the picture has effects, which export can't put on text over video yet. Remove them.`,
      );
    }
    for (const clip of overlay.clips) assertCarried(clip);
  }
  return { picture, overlays };
}

/** A clip's fade of a kind, in frames, clamped to `limit` (0 for none). Two
 *  fades of one kind stack in the mp4 into a curve an editor's single fade
 *  handle can't draw, so they're refused. */
function fadeFrames(
  clip: Clip,
  type: 'fadeIn' | 'fadeOut',
  rate: FrameRate,
  limit: number,
): number {
  const fades = clip.effects.filter((e) => e.type === type);
  if (fades.length > 1) {
    throw new InterchangeError(
      `Clip "${clip.id}" has ${fades.length} ${type === 'fadeIn' ? 'fade-in' : 'fade-out'} effects, which stack in the mp4 into a curve an editor's fade can't draw. Keep one.`,
    );
  }
  const sec = fades[0]?.type === type ? fades[0].durationSec : 0;
  return Math.min(toFrames(sec, rate), limit);
}

interface DocSpan {
  /** Document frames the item covers, and how far output time runs behind. */
  start: number;
  end: number;
  shift: number;
  /** Output frames where the clip finishes fading in from the transition
   *  before it, and starts fading out into the one after it. */
  blendInEnd?: number;
  blendOutStart?: number;
}

/**
 * Check `comp` against what an editor's timeline can hold and lay it out in
 * output frames. Throws `InterchangeError` with the fix for anything refused.
 */
export function buildLayout(comp: Composition, media: Map<MediaId, InterchangeMedia>): Layout {
  const rate = standardRate(comp.fps);
  if (!rate) {
    throw new InterchangeError(
      `The timeline runs at ${comp.fps} fps, which editors don't offer as a project rate. ` +
        `Make the timeline at one of ${PROJECT_RATES.join(', ')} fps (clip timeline new --fps …).`,
    );
  }
  const { picture, overlays } = selectTracks(comp);
  const frames = (sec: number): number => toFrames(sec, rate);

  const clips = [...picture.clips].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1] as Clip;
    const cur = clips[i] as Clip;
    if (cur.startSec < clipEndSec(prev) - ABUT_EPSILON) {
      throw new InterchangeError(
        `Clips "${prev.id}" (ends ${clipEndSec(prev).toFixed(3)}s) and "${cur.id}" (starts ${cur.startSec}s) overlap on the picture track, ` +
          'which an editor timeline can hold only as a transition. Remove the overlap (or add a transition between abutting clips).',
      );
    }
  }
  for (const clip of clips) assertCarried(clip);

  // Document frames of each clip, abutting clips sharing their boundary frame.
  const spans = clips.map((clip, i) => {
    const prev = clips[i - 1];
    const abuts = prev !== undefined && Math.abs(clip.startSec - clipEndSec(prev)) <= ABUT_EPSILON;
    return { clip, abuts, start: frames(clip.startSec), end: frames(clipEndSec(clip)) };
  });
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i] as (typeof spans)[number];
    const prev = spans[i - 1];
    if (span.abuts && prev) span.start = prev.end;
    if (span.end - span.start < 1) {
      throw new InterchangeError(
        `Clip "${span.clip.id}" is shorter than one frame at ${comp.fps} fps. Lengthen or remove it.`,
      );
    }
  }

  // Transition length (frames) after each clip that has a clip right after it.
  const transitionAfter = new Map(picture.transitions.map((t) => [t.afterClipId, t]));
  const blend: Array<{ frames: number; kind: TransitionKind } | null> = spans.map((span, i) => {
    const t = transitionAfter.get(span.clip.id);
    const next = spans[i + 1];
    // A transition after the last clip blends nothing (the mp4 export ignores it too).
    if (!t || !next) return null;
    if (!next.abuts) {
      throw new InterchangeError(
        `Transition after "${span.clip.id}" is followed by a gap, so there is no clip to blend into. ` +
          'Close the gap or remove the transition.',
      );
    }
    if (!CARRIED_TRANSITIONS.has(t.kind)) {
      throw new InterchangeError(
        `Transition after "${span.clip.id}" is "${t.kind}"; interchange export carries fade and dissolve (as a cross dissolve). ` +
          'Change it to fade or dissolve, or export an mp4 instead.',
      );
    }
    const d = Math.max(1, frames(t.durationSec));
    const before = span.end - span.start;
    const after = next.end - next.start;
    if (d >= before || d >= after) {
      throw new InterchangeError(
        `Transition after "${span.clip.id}" is ${t.durationSec}s but must be shorter than both clips it joins ` +
          `(${(before / (rate.den / rate.num)).toFixed(3)}s before it, ${(after / (rate.den / rate.num)).toFixed(3)}s after). ` +
          'Shorten the transition or lengthen the clips.',
      );
    }
    return { frames: d, kind: t.kind };
  });

  const spine: SpineItem[] = [];
  const transitions: LaidTransition[] = [];
  const docSpans: DocSpan[] = [];
  const used = new Map<MediaId, InterchangeMedia>();
  let cursor = 0;
  let shift = 0;
  let docEnd = 0;
  let blendInEnd: number | undefined;

  spans.forEach((span, i) => {
    const { clip } = span;
    if (span.start > docEnd) {
      const length = span.start - docEnd;
      spine.push({ kind: 'gap', offset: cursor, duration: length, fades: { in: 0, out: 0 } });
      docSpans.push({ start: docEnd, end: span.start, shift });
      cursor += length;
    }
    const before = blend[i - 1] ?? null;
    const after = blend[i] ?? null;
    const head = before ? Math.ceil(before.frames / 2) : 0;
    const tail = after ? Math.floor(after.frames / 2) : 0;
    // A clip between two transitions must outlast both, or their blends would
    // overlap into a three-way blend no editor timeline holds.
    if (before && after && before.frames + after.frames > span.end - span.start) {
      throw new InterchangeError(
        `Clip "${clip.id}" is shorter than the transitions on both sides of it together, so they would overlap. ` +
          'Shorten one of the transitions or lengthen the clip.',
      );
    }
    // ≥ 1: each transition is shorter than both clips it joins.
    const visible = span.end - span.start - head - tail;
    // The mp4 export drops a clip's own fade where a transition blends that edge.
    const fades: Fades = {
      in: before ? 0 : fadeFrames(clip, 'fadeIn', rate, visible),
      out: after ? 0 : fadeFrames(clip, 'fadeOut', rate, visible),
    };
    if (fades.in + fades.out > visible) {
      throw new InterchangeError(
        `Clip "${clip.id}" fades in and out over more than its ${(visible / (rate.den / rate.num)).toFixed(3)}s on screen, ` +
          "so the fades overlap, which an editor's fades can't. Shorten the fades.",
      );
    }
    const base = { offset: cursor, duration: visible, fades };

    if (clip.kind === 'media') {
      const info = media.get(clip.mediaId);
      if (!info) {
        throw new InterchangeError(
          `No media registered for "${clip.mediaId}" (clip "${clip.id}").`,
        );
      }
      if (info.durationSec > 0 && clip.sourceOutSec > info.durationSec + rate.num / rate.den) {
        throw new InterchangeError(
          `Clip "${clip.id}" plays its source to ${clip.sourceOutSec}s, but the source is ${info.durationSec}s long, ` +
            'so an editor would find no media there. Trim the clip to the source.',
        );
      }
      used.set(clip.mediaId, info);
      const gain = clip.effects.reduce((g, e) => (e.type === 'volume' ? g * e.gain : g), 1);
      spine.push({
        ...base,
        kind: 'media',
        clipId: clip.id,
        mediaId: clip.mediaId,
        sourceInSec: clip.sourceInSec,
        head,
        gain,
      });
    } else if (clip.kind === 'color') {
      spine.push({
        ...base,
        kind: 'color',
        clipId: clip.id,
        color: colorOf(clip.color, `Color clip "${clip.id}"`),
      });
    } else {
      spine.push({ ...base, kind: 'title', title: titleSpec(clip, picture.id) });
    }
    docSpans.push({ start: span.start, end: span.end, shift, blendInEnd });
    cursor += visible;
    if (after) {
      const cut = cursor;
      const nextHead = Math.ceil(after.frames / 2);
      transitions.push({
        afterIndex: spine.length - 1,
        kind: after.kind,
        offset: cut - nextHead,
        duration: after.frames,
        cut,
      });
      shift += after.frames;
      (docSpans[docSpans.length - 1] as DocSpan).blendOutStart = cut - nextHead;
      blendInEnd = cut - nextHead + after.frames;
    } else {
      blendInEnd = undefined;
    }
    docEnd = span.end;
  });

  // Text over the picture, one title per stretch of output time it shows in.
  const titles: LaidTitle[] = [];
  let nextLane = 1;
  for (const track of [...overlays].sort(
    (a, b) => comp.tracks.indexOf(a) - comp.tracks.indexOf(b),
  )) {
    const laid: LaidTitle[] = [];
    for (const clip of [...track.clips].sort((a, b) => a.startSec - b.startSec)) {
      if (clip.kind !== 'text') continue;
      const from = frames(clip.startSec);
      const to = frames(clipEndSec(clip));
      if (to - from < 1) {
        throw new InterchangeError(
          `Text clip "${clip.id}" is shorter than one frame at ${comp.fps} fps. Lengthen or remove it.`,
        );
      }
      if (clipEndSec(clip) > clipEndSec(clips[clips.length - 1] as Clip) + ABUT_EPSILON) {
        throw new InterchangeError(
          `Text clip "${clip.id}" runs to ${clipEndSec(clip).toFixed(3)}s, past the end of the picture ` +
            `(${(docEnd / (rate.den / rate.num)).toFixed(3)}s), where there is nothing to put it over. Trim or remove it ` +
            '(after cutting a captioned clip, make the captions again).',
        );
      }
      const spec = titleSpec(clip, track.id);
      // A transition moves a clip earlier in output time than the text's part
      // on the clip before it, so order the parts by output time first.
      // Text on a clip fades with that clip where a transition blends it in
      // or out, as the mp4 burns it into the clip's frames.
      const parts = docSpans
        .map((doc) => {
          const start = Math.max(from, doc.start) - doc.shift;
          const end = Math.min(to, doc.end) - doc.shift;
          const fadeIn =
            doc.blendInEnd !== undefined && start < doc.blendInEnd
              ? Math.min(end, doc.blendInEnd) - start
              : 0;
          const fadeOut =
            doc.blendOutStart !== undefined && end > doc.blendOutStart
              ? end - Math.max(start, doc.blendOutStart)
              : 0;
          return { start, end, fades: { in: fadeIn, out: fadeOut } };
        })
        .filter((part) => part.end > part.start)
        .sort((a, b) => a.start - b.start);
      const pieces: typeof parts = [];
      for (const part of parts) {
        const last = pieces[pieces.length - 1];
        // Where both clips show the text (inside a transition) it holds steady:
        // one title, fading only where its outermost part does.
        if (last && part.start <= last.end) {
          if (part.end >= last.end) last.fades.out = part.fades.out;
          last.end = Math.max(last.end, part.end);
        } else {
          pieces.push({ ...part, fades: { ...part.fades } });
        }
      }
      for (const piece of pieces) {
        laid.push({
          ...spec,
          lane: 0,
          offset: piece.start,
          duration: piece.end - piece.start,
          fades: piece.fades,
        });
      }
    }
    // Text a transition makes overlap (the outgoing clip's caption under the
    // incoming one's) goes on separate lanes; its fades make the cross-fade.
    laid.sort((a, b) => a.offset - b.offset);
    const laneEnds = new Map<number, number>();
    const base = nextLane;
    for (const title of laid) {
      let lane = base;
      while ((laneEnds.get(lane) ?? 0) > title.offset) lane++;
      laneEnds.set(lane, title.offset + title.duration);
      title.lane = lane;
      nextLane = Math.max(nextLane, lane + 1);
    }
    titles.push(...laid);
  }

  return {
    rate,
    width: comp.width,
    height: comp.height,
    background: colorOf(comp.background, 'The timeline background'),
    duration: cursor,
    spine,
    transitions,
    titles,
    media: used,
  };
}

/** Audio channels a probe's layout name means (`stereo` → 2, `5.1(side)` → 6). */
export function channelCount(layout: string): number {
  const named: Record<string, number> = { mono: 1, stereo: 2, quad: 4 };
  const head = layout.split('(')[0] ?? '';
  if (named[head]) return named[head];
  const surround = head.match(/^(\d+)\.(\d+)$/);
  if (surround) return Number(surround[1]) + Number(surround[2]);
  const n = Number.parseInt(head, 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** A short name for a source file, without directory or extension. */
export function mediaName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

// ─── XML text ────────────────────────────────────────────────────────────────

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Attributes as ` key="value"` pairs, skipping undefined ones. */
export function attrs(values: Record<string, string | number | undefined>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('');
}
