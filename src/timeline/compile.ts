import { resolve } from 'node:path';
import { buildPreviewFrameArgs } from '../ffmpeg/args/preview.js';
import { buildTransitionArgs } from '../ffmpeg/args/transition.js';
import { quoteFilterArg } from '../ffmpeg/escape.js';
import { fontFileFor, MissingFontError } from '../ffmpeg/font.js';
import { invalidColorMessage, isColor } from './color.js';
import {
  type Clip,
  type Composition,
  clipDuration,
  clipEndSec,
  type Effect,
  type EffectType,
  type Fit,
  type TextClip,
  type Track,
} from './composition.js';
import type { MediaId } from './schema.js';

/**
 * Pragmatic v1 export compiler: lower a CompositionDoc to an ordered plan of
 * FFmpeg steps using the SEGMENT-AND-CONCAT strategy. Each clip is normalized to
 * a uniformly-encoded segment (canvas size/fps, effects baked in, guaranteed
 * audio); consecutive segments are then folded together with a hard cut (concat
 * filter) or a crossfade (xfade), reusing the same primitives the standalone
 * tools already ship.
 *
 * The compiler is PURE: every duration/offset is known from the document (no
 * probing), intermediate paths are derived deterministically from clip ids, and
 * the result is a plan of arg arrays a runner executes. That makes it testable
 * exactly like the other arg-builders — assert the args, no FFmpeg in CI.
 *
 * v1 scope is a single video-track sequence of abutting clips, plus text-only
 * tracks above it (captions, titles over the picture), which each segment burns
 * in for the stretch of timeline it covers. Constructs that need true
 * compositing — a second track of media/color clips, audio tracks, a rotated
 * or partly transparent clip, chromaKey (which needs a background layer), or
 * gaps/overlaps on the picture track — throw a clear `CompileError` rather than
 * emitting a wrong graph. Media clips are framed onto the canvas by fit, zoom and
 * position (see `clipFraming`).
 *
 * Text outside Latin is drawn with a font file that has its glyphs (see
 * `ffmpeg/font.ts`); that lookup reads font files, once per process, unless the
 * context supplies `fontFor`.
 *
 * Transition boundaries own their blend: a per-clip fadeOut/fadeIn on the SAME
 * cut as a transition is dropped during segment normalization (see the
 * `FadeSuppression` plumbing), so the xfade's blend isn't stacked over a fade
 * over the same window. Fades on outer boundaries (open from black, close to
 * black) and on plain cuts are untouched.
 *
 * A hard cut between two clips also gets a few milliseconds of audio fade on
 * each side (see `Joins`), so the waveform meets the cut at zero instead of
 * jumping, which is what makes a cut click.
 */

export interface MediaInfo {
  path: string;
  hasAudio: boolean;
  /** Whether the source has a video stream; unknown (undefined) counts as yes. */
  hasVideo?: boolean;
}

export interface CompileContext {
  /** mediaId → resolved file path + whether it carries an audio stream. */
  media: Map<MediaId, MediaInfo>;
  /** Directory for intermediate segments and any generated text files. */
  dir: string;
  /** Final output file path. */
  output: string;
  /**
   * Optional token mixed into intermediate (segment / text / fold) filenames.
   * Those names are otherwise deterministic (`tl-seg-<index>-<clip>`), so a
   * preview render and a concurrent export would write and `-y`-overwrite the
   * SAME files and unlink each other's. A per-request tag (the `clip ui` sets
   * one per frame request) gives the preview its own collision-free paths.
   */
  tag?: string;
  /** Font file for a text, or undefined for FFmpeg's default font; throws
   *  `MissingFontError` when none has its glyphs. `always` asks for a file for
   *  Latin text too (captions). Defaults to `fontFileFor`. */
  fontFor?: (text: string, always: boolean) => string | undefined;
}

/** A side file (concat list / drawtext text) the runner must write before
 *  executing `args`. Kept in the plan so it stays declarative and testable. */
export interface StepSideFile {
  path: string;
  content: string;
}

export interface FfmpegStep {
  /** Debug label, e.g. `segment:clip_ab12` or `fold:1`. */
  label: string;
  args: string[];
  output: string;
  /** Text files (drawtext) this step needs on disk first. */
  textFiles: StepSideFile[];
}

export interface FfmpegPlan {
  steps: FfmpegStep[];
  output: string;
  /** Wall-clock duration of the composed result, in seconds. */
  durationSec: number;
  /** Normalize the finished output to this loudness (`runPlan` measures it
   *  first, so it can't be a fixed step). Export only; never set for a frame. */
  loudness?: { targetLufs: number };
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

const VIDEO_ENCODE = [
  '-c:v',
  'libx264',
  '-preset',
  'fast',
  '-crf',
  '23',
  '-pix_fmt',
  'yuv420p',
] as const;
const AUDIO_ENCODE = ['-c:a', 'aac', '-ar', '48000'] as const;
const SAMPLE_RATE = 48000;

/** How a clip's picture sits on the canvas, with every default filled in. */
export interface Framing {
  fit: Fit;
  scale: number;
  /** Alignment in [0,1]: 0 = left/top edges together, 1 = right/bottom. */
  x: number;
  y: number;
}

/**
 * The framing export applies to a clip: its transform's values over the
 * defaults. The canvas `fit` applies to media clips only — text and color clips
 * are generated at canvas size, so captions and title cards don't change when
 * the canvas is set to cover.
 */
export function clipFraming(comp: Composition, clip: Clip): Framing {
  const t = clip.transform;
  return {
    fit: clip.kind === 'media' ? (t?.fit ?? comp.fit) : 'contain',
    scale: t?.scale ?? 1,
    x: t?.x ?? 0.5,
    y: t?.y ?? 0.5,
  };
}

/** Whole picture, centered, unzoomed: the plain fit-and-pad export has always used. */
export function isDefaultFraming(f: Framing): boolean {
  return f.fit === 'contain' && f.scale === 1 && f.x === 0.5 && f.y === 0.5;
}

/** Net speed multiplier from the effect stack (1 when none). */
export function speedFactor(effects: Effect[]): number {
  return effects.reduce((f, e) => (e.type === 'speed' ? f * e.factor : f), 1);
}

const isTextOnly = (track: Track): boolean => track.clips.every((c) => c.kind === 'text');

/**
 * Split the populated video tracks into the picture track (the one holding
 * media/color clips, else the lowest) and the text-only tracks drawn over it.
 * Pure and non-throwing, so the cut review can skip text tracks too: caption
 * boundaries aren't cuts.
 */
export function videoLayers(comp: Composition): { picture: Track | undefined; overlays: Track[] } {
  const populated = comp.tracks.filter((t) => t.kind === 'video' && t.clips.length > 0);
  const withPicture = populated.filter((t) => !isTextOnly(t));
  const picture = withPicture.length > 1 ? undefined : (withPicture[0] ?? populated[0]);
  return { picture, overlays: populated.filter((t) => t !== picture && isTextOnly(t)) };
}

/** The document without the text over its picture: what a cut's exportability
 *  check looks at, since captions don't move with a cut and are made again after
 *  one. */
export function withoutTextOverlays(comp: Composition): Composition {
  const overlays = new Set(videoLayers(comp).overlays);
  if (overlays.size === 0) return comp;
  return {
    ...comp,
    tracks: comp.tracks.map((t) => (overlays.has(t) ? { ...t, clips: [], transitions: [] } : t)),
  };
}

/** The picture track to export and the text clips drawn over it, with v1's
 *  "no compositing yet" guards. */
function selectLayers(comp: Composition): { track: Track; overlays: TextClip[] } {
  const populatedAudio = comp.tracks.filter((t) => t.kind === 'audio' && t.clips.length > 0);
  if (populatedAudio.length > 0) {
    throw new CompileError(
      'Separate audio tracks are not supported in export yet — audio comes from the video clips. Move audio onto the video track or remove the audio track.',
    );
  }
  if (!comp.tracks.some((t) => t.kind === 'video' && t.clips.length > 0)) {
    throw new CompileError('Nothing to export: no video track has clips.');
  }
  const { picture: track, overlays } = videoLayers(comp);
  if (!track) {
    throw new CompileError(
      'Multi-track overlay export is not supported yet — flatten to a single video track first (only text can sit on a track above it).',
    );
  }
  const pictureIndex = comp.tracks.indexOf(track);
  const clips: TextClip[] = [];
  for (const overlay of overlays) {
    if (comp.tracks.indexOf(overlay) < pictureIndex) {
      throw new CompileError(
        `Text track "${overlay.id}" is under track "${track.id}", so the picture would hide it. ` +
          'Put the text on a track above it.',
      );
    }
    if (overlay.transitions.length > 0) {
      throw new CompileError(
        `Text track "${overlay.id}" has transitions, which export can't draw over video yet. Remove them.`,
      );
    }
    // Lower tracks first, so a higher track's text is drawn over theirs.
    for (const clip of [...overlay.clips].sort((a, b) => a.startSec - b.startSec)) {
      if (clip.kind !== 'text') continue;
      assertCompilable(clip);
      if (clip.effects.length > 0) {
        throw new CompileError(
          `Text clip "${clip.id}" over the picture has effects, which export can't draw over video yet. Remove them.`,
        );
      }
      clips.push(clip);
    }
  }
  const end = track.clips.reduce((max, c) => Math.max(max, clipEndSec(c)), 0);
  const late = clips.find((c) => clipEndSec(c) > end + ABUT_EPSILON);
  if (late) {
    throw new CompileError(
      `Text clip "${late.id}" runs to ${clipEndSec(late).toFixed(3)}s, past the end of the picture ` +
        `(${end.toFixed(3)}s), where there is nothing to draw it over. Trim or remove it ` +
        '(after cutting a captioned clip, make the captions again).',
    );
  }
  return { track, overlays: clips };
}

function assertCompilable(clip: Clip): void {
  const t = clip.transform;
  if (t && (t.rotationDeg !== 0 || t.opacity !== 1)) {
    throw new CompileError(
      `Clip "${clip.id}" is rotated or partly transparent — rotation and opacity are not supported in export yet (fit, zoom and position are).`,
    );
  }
  if (t && (t.x < 0 || t.x > 1 || t.y < 0 || t.y > 1)) {
    throw new CompileError(
      `Clip "${clip.id}" has position x=${t.x}, y=${t.y}; both must be between 0 and 1 (0 = left/top, 0.5 = center, 1 = right/bottom).`,
    );
  }
  if (clip.kind !== 'media' && t && (t.scale !== 1 || t.x !== 0.5 || t.y !== 0.5)) {
    throw new CompileError(
      `${clip.kind === 'text' ? 'Text' : 'Color'} clip "${clip.id}" has a zoom or position — export frames media clips only. ` +
        'Place text with its anchor.',
    );
  }
  if (clip.effects.some((e) => e.type === 'chromaKey')) {
    throw new CompileError(
      `Clip "${clip.id}" uses chromaKey, which needs a background layer — not supported in single-track export yet.`,
    );
  }
}

/** Output (post-speed) duration of a clip on the timeline. */
function outputDuration(clip: Clip): number {
  const base = clipDuration(clip);
  // Speed only applies to real media; it's meaningless on generated text/color.
  return clip.kind === 'media' ? base / speedFactor(clip.effects) : base;
}

interface FilterChains {
  video: string[];
  audio: string[];
}

/** Whether a clip's leading/trailing per-clip fade should be dropped because a
 *  transition already owns the blend over that boundary (else they double-darken). */
/** Audio fade on each side of a hard cut, seconds: long enough to bring the
 *  waveform to zero at the join, too short to hear as a dip. */
const JOIN_FADE_SEC = 0.008;

/** Which edges of a clip meet another clip at a hard cut (no transition). */
interface Joins {
  head: boolean;
  tail: boolean;
}

/** The join fades for a clip's edges, in output time. An edge with a fade of
 *  the clip's own already reaches silence there, so it gets none. */
function joinFades(clip: Clip, outDur: number, joins: Joins): string[] {
  const d = Math.min(JOIN_FADE_SEC, outDur / 2);
  const has = (type: EffectType): boolean => clip.effects.some((e) => e.type === type);
  const fades: string[] = [];
  if (joins.head && !has('fadeIn')) fades.push(`afade=t=in:st=0:d=${seconds(d)}`);
  if (joins.tail && !has('fadeOut')) {
    // Start rounded DOWN to the millisecond, so the fade reaches silence at or
    // before the end of the segment (afade holds silence after it), never past it.
    const st = Math.floor((outDur - d) * 1000 + 1e-6) / 1000;
    fades.push(`afade=t=out:st=${st}:d=${seconds(d)}`);
  }
  return fades;
}

interface FadeSuppression {
  in: boolean;
  out: boolean;
}

/** Translate a clip's effect stack into video/audio filter fragments, applied
 *  after the geometry/source fragments. Order: color → speed → fades. A fade on a
 *  boundary that carries a transition is skipped (`suppress`) so the xfade's blend
 *  isn't stacked over a per-clip fade on the same window. */
function effectFilters(
  clip: Clip,
  outDur: number,
  fps: number,
  suppress: FadeSuppression = { in: false, out: false },
): FilterChains {
  const video: string[] = [];
  const audio: string[] = [];

  for (const e of clip.effects) {
    if (e.type === 'adjust') {
      const parts: string[] = [];
      if (e.brightness !== 0) parts.push(`brightness=${e.brightness}`);
      if (e.contrast !== 1) parts.push(`contrast=${e.contrast}`);
      if (e.saturation !== 1) parts.push(`saturation=${e.saturation}`);
      if (parts.length) video.push(`eq=${parts.join(':')}`);
    } else if (e.type === 'volume') {
      audio.push(`volume=${e.gain}`);
    }
  }

  // Speed (media only) retimes both streams; outDur already accounts for it.
  if (clip.kind === 'media') {
    const f = speedFactor(clip.effects);
    if (f !== 1) {
      // Back to the canvas rate right away: retimed frames otherwise reach the
      // encoder off its frame grid, and which ones it drops or repeats varies,
      // so a frame preview couldn't show the frame export plays.
      video.push(`setpts=PTS/${f}`, `fps=${fps}`);
      audio.push(atempoChain(f));
    }
  }

  for (const e of clip.effects) {
    // Clamp the fade to the clip so a fade longer than the clip still reaches
    // full black/silence within the available window instead of ramping partway.
    // Skip the fade entirely when a transition owns this boundary (the xfade
    // already blends that window — a per-clip fade on top double-darkens it).
    if (e.type === 'fadeIn' && !suppress.in) {
      const d = Math.min(e.durationSec, outDur);
      video.push(`fade=t=in:st=0:d=${d}`);
      audio.push(`afade=t=in:st=0:d=${d}`);
    } else if (e.type === 'fadeOut' && !suppress.out) {
      const d = Math.min(e.durationSec, outDur);
      const st = Math.max(0, outDur - d);
      video.push(`fade=t=out:st=${st}:d=${d}`);
      audio.push(`afade=t=out:st=${st}:d=${d}`);
    }
  }

  return { video, audio };
}

/** atempo only accepts [0.5,2]; chain links for anything outside. Mirrors the
 *  speed tool's helper so segment audio retiming matches the standalone tool. */
function atempoChain(factor: number): string {
  const links: string[] = [];
  let remaining = factor;
  while (remaining >= 2) {
    links.push('atempo=2.0');
    remaining /= 2;
  }
  while (remaining <= 0.5 && remaining !== 1) {
    links.push('atempo=0.5');
    remaining *= 2;
  }
  if (Math.abs(remaining - 1) > 0.0001) links.push(`atempo=${remaining}`);
  return links.join(',');
}

const SEG_PREFIX = 'tl-seg';
const FOLD_PREFIX = 'tl-fold';
const TEXT_PREFIX = 'tl-text';

/** A disambiguating infix for intermediate filenames — `<tag>-` when a tag is
 *  set (a preview's collision-free paths), empty otherwise (export's stable ones). */
function tagInfix(tag: string | undefined): string {
  return tag ? `${tag}-` : '';
}

function segPath(dir: string, index: number, clipId: string, tag?: string): string {
  return resolve(dir, `${SEG_PREFIX}-${tagInfix(tag)}${index}-${clipId}.mp4`);
}

/**
 * A clip's segment filters after its input: the video chain (framing onto the
 * canvas, a text clip's own text, effects, then the text over it) and the audio
 * effects. Shared by export and the frame preview, so a preview can't drift
 * from what export draws.
 */
function clipChains(
  comp: Composition,
  clip: Clip,
  index: number,
  ctx: CompileContext,
  overlays: TextClip[],
  fadeSuppress: FadeSuppression = { in: false, out: false },
): { chain: string; audio: string[]; textFiles: StepSideFile[] } {
  const outDur = outputDuration(clip);
  const { width, height, fps, background } = comp;
  const { video: fx, audio } = effectFilters(clip, outDur, fps, fadeSuppress);
  const textFiles: StepSideFile[] = [];

  if (clip.kind === 'text') {
    const textfile = resolve(ctx.dir, `${TEXT_PREFIX}-${tagInfix(ctx.tag)}${index}-${clip.id}.txt`);
    textFiles.push({ path: textfile, content: clip.text });
    fx.unshift(drawtextFilter(textfile, clip, fontFor(ctx, clip, false)));
  }

  // Overlay times are timeline seconds; the segment runs in output time, which
  // a speed effect scales.
  const ratio = clipDuration(clip) > 0 ? outDur / clipDuration(clip) : 1;
  const end = clipEndSec(clip);
  for (const overlay of overlays) {
    const from = Math.max(overlay.startSec, clip.startSec);
    const to = Math.min(clipEndSec(overlay), end);
    if (to - from <= ABUT_EPSILON) continue;
    const textfile = resolve(
      ctx.dir,
      `${TEXT_PREFIX}-${tagInfix(ctx.tag)}${index}-${clip.id}-${overlay.id}.txt`,
    );
    textFiles.push({ path: textfile, content: overlay.text });
    const window = `gte(t,${seconds((from - clip.startSec) * ratio)})*lt(t,${seconds((to - clip.startSec) * ratio)})`;
    fx.push(drawtextFilter(textfile, overlay, fontFor(ctx, overlay, true), window));
  }

  // Geometry first: frame onto the canvas, square pixels, lock fps. (No-op-ish
  // for generated sources that are already canvas-sized, but keeps the chain uniform.)
  const geometry = [
    ...framingFilters(clipFraming(comp, clip), width, height, background),
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
  ];
  return { chain: [...geometry, ...fx].join(','), audio, textFiles };
}

/**
 * Normalize one clip to a self-contained segment: canvas-sized video at the
 * composition fps, effects baked in, and a guaranteed stereo AAC audio track
 * (the source's, or generated silence) so the fold can always join segments.
 * Text clips from the tracks above that overlap the clip are drawn last, over
 * its effects, for the part of them inside it.
 */
function buildSegmentStep(
  comp: Composition,
  clip: Clip,
  index: number,
  ctx: CompileContext,
  overlays: TextClip[],
  fadeSuppress: FadeSuppression = { in: false, out: false },
  joins: Joins = { head: false, tail: false },
): FfmpegStep {
  assertCompilable(clip);
  const outDur = outputDuration(clip);
  const { width, height, fps, background } = comp;
  const out = segPath(ctx.dir, index, clip.id, ctx.tag);
  const {
    chain: videoChain,
    audio: afx,
    textFiles,
  } = clipChains(comp, clip, index, ctx, overlays, fadeSuppress);

  const inputArgs: string[] = [];
  let videoSource: string; // filtergraph input label feeding the video chain, e.g. [0:v]
  let audioSource: string; // BARE stream specifier (e.g. 0:a) — bracket only when fed to a filter

  if (clip.kind === 'media') {
    const info = ctx.media.get(clip.mediaId);
    if (!info)
      throw new CompileError(`No media registered for "${clip.mediaId}" (clip "${clip.id}").`);
    // Input-seek to the trim in-point; the chain + final -t bound the window.
    inputArgs.push('-ss', String(clip.sourceInSec), '-i', info.path);
    videoSource = '[0:v]';
    if (info.hasAudio) {
      audioSource = '0:a';
    } else {
      inputArgs.push(
        '-f',
        'lavfi',
        '-i',
        `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`,
      );
      audioSource = '1:a';
    }
  } else if (clip.kind === 'color') {
    inputArgs.push(
      '-f',
      'lavfi',
      '-i',
      `color=c=${quoteColor(clip.color, `Color clip "${clip.id}" color`)}:s=${width}x${height}:r=${fps}`,
    );
    inputArgs.push(
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`,
    );
    videoSource = '[0:v]';
    audioSource = '1:a';
  } else {
    // text: a background-colour source with drawtext burned in.
    inputArgs.push(
      '-f',
      'lavfi',
      '-i',
      `color=c=${quoteColor(background, CANVAS_BACKGROUND)}:s=${width}x${height}:r=${fps}`,
    );
    inputArgs.push(
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`,
    );
    videoSource = '[0:v]';
    audioSource = '1:a';
  }

  // Always normalize audio to a uniform stereo/48k layout BEFORE any effects, so
  // the fold's concat/acrossfade can't silently downmix when a source clip is
  // mono (and so every segment exposes a real [a] output). aformat is a harmless
  // no-op for the already-stereo silence sources. This makes the "guaranteed
  // stereo AAC audio" invariant real, not aspirational.
  // Join fades only where there is sound to click: generated silence needs none.
  const hasSound = clip.kind === 'media' && ctx.media.get(clip.mediaId)?.hasAudio === true;
  const audioChain = [
    'aformat=sample_rates=48000:channel_layouts=stereo',
    ...afx,
    ...(hasSound ? joinFades(clip, outDur, joins) : []),
  ].join(',');

  const filterParts = [`${videoSource}${videoChain}[v]`, `[${audioSource}]${audioChain}[a]`];
  const audioMap = '[a]';

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[v]',
    '-map',
    audioMap,
    '-t',
    String(outDur),
    ...VIDEO_ENCODE,
    ...AUDIO_ENCODE,
    out,
  ];

  return { label: `segment:${clip.id}`, args, output: out, textFiles };
}

/**
 * Scale, crop and pad a picture onto a `width`x`height` canvas. The default
 * framing keeps the plain fit-and-center chain. Otherwise: scale to fit
 * (contain) or cover the canvas times the zoom, crop whatever overflows at the
 * alignment, then pad whatever falls short at the same alignment — so one chain
 * handles crop and bars on either axis.
 */
function framingFilters(
  framing: Framing,
  width: number,
  height: number,
  background: string,
): string[] {
  const pad = `color=${quoteColor(background, CANVAS_BACKGROUND)}`;
  if (isDefaultFraming(framing)) {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${pad}`,
    ];
  }
  const { x, y } = framing;
  const mode = framing.fit === 'cover' ? 'increase' : 'decrease';
  return [
    `scale=${even(width * framing.scale)}:${even(height * framing.scale)}:force_original_aspect_ratio=${mode}:force_divisible_by=2`,
    `crop=w=${quoteFilterArg(`min(iw,${width})`)}:h=${quoteFilterArg(`min(ih,${height})`)}` +
      `:x=${quoteFilterArg(`(iw-ow)*${x}`)}:y=${quoteFilterArg(`(ih-oh)*${y}`)}`,
    `pad=${width}:${height}:x=${quoteFilterArg(`(ow-iw)*${x}`)}:y=${quoteFilterArg(`(oh-ih)*${y}`)}:${pad}`,
  ];
}

/** Nearest even size of at least 2: x264 needs even sides, and scale=0 means "keep". */
function even(size: number): number {
  return Math.max(2, Math.round(size / 2) * 2);
}

/** Seconds for a filter expression: millisecond precision, no float noise. */
function seconds(sec: number): string {
  return String(Math.round(sec * 1000) / 1000);
}

/** How much of the source a frame preview reads before the frame, at least. */
const FRAME_PREROLL_SEC = 1;

function floorUs(sec: number): number {
  return Math.floor(sec * 1e6 + 1e-6) / 1e6;
}

/** The font file for a text clip, with a missing font reported against the clip.
 *  Text over the picture always gets a file: see `ffmpeg/font.ts`. */
function fontFor(ctx: CompileContext, clip: TextClip, always: boolean): string | undefined {
  try {
    return ctx.fontFor ? ctx.fontFor(clip.text, always) : fontFileFor(clip.text, { always });
  } catch (err) {
    if (err instanceof MissingFontError)
      throw new CompileError(`Text clip "${clip.id}": ${err.message}`);
    throw err;
  }
}

/** drawtext for a text clip; `enable` limits it to a window of the segment.
 *  `expansion=none`: spoken text like "50%" must not read as a % sequence. */
function drawtextFilter(
  textfile: string,
  clip: TextClip,
  fontFile: string | undefined,
  enable?: string,
): string {
  const { style } = clip;
  const pos = anchorPosition(style.anchor, style.margin);
  const opts = [`textfile=${quoteFilterArg(textfile)}`];
  if (fontFile) opts.push(`fontfile=${quoteFilterArg(fontFile)}`);
  opts.push(
    'expansion=none',
    `fontsize=${style.fontSize}`,
    `fontcolor=${quoteFilterArg(style.color)}`,
    `x=${quoteFilterArg(pos.x)}`,
    `y=${quoteFilterArg(pos.y)}`,
  );
  if (style.background) {
    opts.push('box=1', `boxcolor=${quoteFilterArg(style.background)}`, 'boxborderw=12');
  }
  if (enable) opts.push(`enable=${quoteFilterArg(enable)}`);
  return `drawtext=${opts.join(':')}`;
}

/** Inset of anchored text from the frame edges when its style sets none. */
export const TEXT_EDGE_PX = 40;

/** drawtext x/y for an anchor, kept `margin` pixels in from the edges it is
 *  anchored to. */
function anchorPosition(
  anchor: string,
  margin: { x: number; y: number } = { x: TEXT_EDGE_PX, y: TEXT_EDGE_PX },
): { x: string; y: string } {
  const x = anchor.endsWith('left')
    ? `${margin.x}`
    : anchor.endsWith('right')
      ? `w-text_w-${margin.x}`
      : '(w-text_w)/2';
  const y = anchor.startsWith('top')
    ? `${margin.y}`
    : anchor.startsWith('bottom')
      ? `h-text_h-${margin.y}`
      : '(h-text_h)/2';
  return { x, y };
}

const CANVAS_BACKGROUND = 'Canvas background';

/** color filter `c=` rejects '#rrggbb'; normalize to 0x form, pass names through.
 *  The value lands unquoted in the graph, so anything but a color is refused: a
 *  stored document is only as safe as whatever wrote it. */
function quoteColor(color: string, what: string): string {
  if (!isColor(color)) throw new CompileError(`${what} ${invalidColorMessage(color)}`);
  return color.startsWith('#') ? `0x${color.slice(1)}` : color;
}

/** Hard-cut concat of two normalized segments via the concat filter (both have
 *  v+a in the same format, so n=2:v=1:a=1 is safe). */
function buildHardCutArgs(a: string, b: string, output: string): string[] {
  return [
    '-y',
    '-i',
    a,
    '-i',
    b,
    '-filter_complex',
    '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...VIDEO_ENCODE,
    ...AUDIO_ENCODE,
    output,
  ];
}

/** Tolerance (seconds) for the abutting-sequence check — clip starts are float
 *  sums of durations, so allow a hair of accumulated rounding. */
const ABUT_EPSILON = 1e-4;

/**
 * v1 renders a track as an abutting sequence. Reject gaps/overlaps with a clear
 * error rather than silently collapsing them — the document is the source of
 * truth, so neither export NOR the frame preview may diverge from the timeline it
 * describes. `clips` must be pre-sorted by `startSec`.
 */
function assertAbutting(clips: Clip[]): void {
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1];
    const cur = clips[i];
    if (!prev || !cur) continue;
    const prevEnd = clipEndSec(prev);
    const delta = cur.startSec - prevEnd;
    if (Math.abs(delta) > ABUT_EPSILON) {
      const kind = delta > 0 ? 'gap' : 'overlap';
      throw new CompileError(
        `Timeline ${kind} between "${prev.id}" (ends ${prevEnd.toFixed(3)}s) and "${cur.id}" ` +
          `(starts ${cur.startSec}s): the timeline needs clips to abut. ` +
          `${kind === 'gap' ? 'Close the gap (or add a filler clip)' : 'Remove the overlap'} — ` +
          `positioned gaps/overlaps are not supported yet.`,
      );
    }
  }
}

/**
 * Render ONE frame at timeline time `atSec` — the agent's "eyes" on the doc.
 * Uses the segment's own video chain (`clipChains`) so the preview can't diverge
 * from what export would produce. A media clip is one step: seek the source to
 * the frame and run the chain on a window starting there, with the timestamps
 * offset so fades and text windows read the time they would in the segment, so
 * the cost doesn't grow with the clip's length. A text or color card (generated,
 * and short) is two: encode its segment, then grab the frame from it. Runs the
 * SAME abutting check as export, so it fails (rather than guessing a clip) on an
 * unexportable doc; throws `CompileError` past the end, in a gap, or on an
 * overlap, and inherits the v1 single-video-track / no-compositing guards.
 *
 * Known v1 limit (flag, don't fix here): a frame inside a transition window
 * shows the underlying clip, not the xfade blend.
 */
export function buildFrameAtPlan(
  comp: Composition,
  ctx: CompileContext,
  atSec: number,
): FfmpegPlan {
  if (atSec < 0) throw new CompileError(`Frame time ${atSec}s is before the timeline start.`);
  const { track, overlays } = selectLayers(comp);
  const clips = [...track.clips].sort((a, b) => a.startSec - b.startSec);
  // Fail the way export does on an unexportable doc, so the preview tells the
  // truth instead of silently picking one of several overlapping clips.
  assertAbutting(clips);
  const index = clips.findIndex((c) => atSec >= c.startSec && atSec < clipEndSec(c));
  const clip = clips[index];
  if (!clip) {
    const last = clips[clips.length - 1];
    const end = last ? clipEndSec(last) : 0;
    throw new CompileError(
      `No clip at ${atSec}s — the timeline runs to ${end.toFixed(3)}s and ${atSec}s is ` +
        `${atSec >= end ? 'past the end' : 'in a gap'}.`,
    );
  }
  assertCompilable(clip);

  // Map doc-local time to the post-speed SEGMENT timebase. The ratio is 1 unless
  // the clip carries a speed effect, which shortens the segment relative to the
  // document extent — so a frame still lands on the source content the document
  // places at `atSec`.
  const clipDur = clipDuration(clip);
  const outDur = outputDuration(clip);
  const localDoc = atSec - clip.startSec;
  const segTime = clipDur > 0 ? (localDoc * outDur) / clipDur : 0;
  const lastFrame = Math.max(0, outDur - 1 / comp.fps);
  const clamped = Math.max(0, Math.min(segTime, lastFrame));
  const label = `frame:${clip.id}@${atSec}`;

  if (clip.kind === 'media') {
    const info = ctx.media.get(clip.mediaId);
    if (!info) {
      throw new CompileError(`No media registered for "${clip.mediaId}" (clip "${clip.id}").`);
    }
    // Seconds into the clip's source. The seek lands a second before that and
    // keeps every frame from the keyframe before it (`-noaccurate_seek`), so a
    // frame that export repeats into this time (a source slower than the
    // canvas, slow motion, or a screen recording holding a still frame) is
    // still read; undoing the seek gives source time from the clip's in-point.
    // Frames before the in-point are dropped, as export's seek drops them. The
    // chain's speed `setpts` turns source time into segment time, which its
    // fades and text read, and `trim` takes the frame at the frame's segment
    // time. Rounded down, to the microsecond, so the seek never passes the
    // clip's last frame or its out-point.
    const local = floorUs(clamped * speedFactor(clip.effects));
    const seek = floorUs(clip.sourceInSec + Math.max(0, local - FRAME_PREROLL_SEC));
    // The first canvas frame at or after the frame's time (`trim` rounds an
    // off-grid start to the nearest frame, which could be the one before), but
    // no later than the segment's last frame: encoding to the clip's length
    // keeps round(length x fps) frames.
    const lastIndex = Math.max(0, Math.round(outDur * comp.fps) - 1);
    const firstFrame = Math.min(Math.ceil(clamped * comp.fps - 1e-6), lastIndex) / comp.fps;
    const { chain, textFiles } = clipChains(comp, clip, index, ctx, overlays);
    const frameStep: FfmpegStep = {
      label,
      args: [
        '-y',
        '-noaccurate_seek',
        '-ss',
        String(seek),
        '-i',
        info.path,
        '-filter_complex',
        // The seek shifted timestamps by (in-point + local) in whole stream
        // ticks; shifting back by the same rounding leaves them as export's
        // seek to the in-point does, tick for tick.
        `[0:v]setpts=PTS+round(${seek}/TB)-round(${floorUs(clip.sourceInSec)}/TB),trim=start=0,${chain},trim=start=${firstFrame}[v]`,
        ...['-map', '[v]', '-an', '-frames:v', '1', '-q:v', '2'],
        ctx.output,
      ],
      output: ctx.output,
      textFiles,
    };
    return { steps: [frameStep], output: ctx.output, durationSec: 0 };
  }

  // Encode the card's segment exactly as export would, then extract the frame.
  const segStep = buildSegmentStep(comp, clip, index, ctx, overlays);
  const frameStep: FfmpegStep = {
    label,
    args: buildPreviewFrameArgs({ input: segStep.output, output: ctx.output, atSec: clamped }),
    output: ctx.output,
    textFiles: [],
  };

  return { steps: [segStep, frameStep], output: ctx.output, durationSec: 0 };
}

/**
 * Dry-run the export compiler (pure — no FFmpeg runs) to report whether the
 * document can render and, if not, the first blocking reason. Shared by the CLI
 * `timeline show`, the `clip ui` exportable route, and the MCP `timeline_show`
 * so every surface tells the agent the SAME thing about renderability.
 */
export function checkExportable(
  comp: Composition,
  media: Map<MediaId, MediaInfo>,
  dir: string,
): { exportable: boolean; blockers: string[] } {
  try {
    compileTimeline(comp, { media, dir, output: resolve(dir, '.probe.mp4') });
    return { exportable: true, blockers: [] };
  } catch (err) {
    if (err instanceof CompileError) return { exportable: false, blockers: [err.message] };
    throw err;
  }
}

export function compileTimeline(comp: Composition, ctx: CompileContext): FfmpegPlan {
  const { track, overlays } = selectLayers(comp);
  const clips = [...track.clips].sort((a, b) => a.startSec - b.startSec);
  const transitionAfter = new Map(track.transitions.map((t) => [t.afterClipId, t]));

  assertAbutting(clips);

  const steps: FfmpegStep[] = [];

  // 1. Normalize every clip to a segment. Drop a per-clip fade on a boundary that
  // a transition already blends: fadeOut when a transition follows this clip,
  // fadeIn when one precedes it (the preceding clip has a transition after it).
  // The fold (step 2) only xfades a transition that has a FOLLOWING clip, so a
  // transition keyed to the last clip (e.g. left dangling after the next clip was
  // removed) blends nothing — keep that clip's fadeOut rather than silently
  // dropping a fade-to-black to a hard cut.
  const segments = clips.map((clip, i) => {
    const prevClip = clips[i - 1];
    const fadeSuppress: FadeSuppression = {
      in: prevClip ? transitionAfter.has(prevClip.id) : false,
      out: i < clips.length - 1 && transitionAfter.has(clip.id),
    };
    const joins: Joins = {
      head: prevClip !== undefined && !transitionAfter.has(prevClip.id),
      tail: i < clips.length - 1 && !transitionAfter.has(clip.id),
    };
    const step = buildSegmentStep(comp, clip, i, ctx, overlays, fadeSuppress, joins);
    steps.push(step);
    return { clip, output: step.output, durationSec: outputDuration(clip) };
  });

  // Single clip: the segment IS the result — re-target it to the final output.
  if (segments.length === 1) {
    const only = steps[0];
    if (!only) throw new CompileError('Nothing to export.');
    only.args[only.args.length - 1] = ctx.output;
    only.output = ctx.output;
    return {
      steps,
      output: ctx.output,
      durationSec: segments[0]?.durationSec ?? 0,
      ...loudnessOf(comp),
    };
  }

  // 2. Fold left-to-right: xfade where a transition follows the clip, else cut.
  let accPath = segments[0]?.output as string;
  let accDur = segments[0]?.durationSec ?? 0;

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const prevClip = segments[i - 1]?.clip;
    const transition = prevClip ? transitionAfter.get(prevClip.id) : undefined;
    const isLast = i === segments.length - 1;
    const out = isLast
      ? ctx.output
      : resolve(ctx.dir, `${FOLD_PREFIX}-${tagInfix(ctx.tag)}${i}.mp4`);

    if (transition) {
      // A transition must fit inside BOTH sides: the accumulated A (offset ≥ 0)
      // and the next segment B. An over-long xfade/acrossfade otherwise produces
      // a degenerate blend or an intermediate with no audio stream that fails the
      // next fold — so reject it explicitly (the standalone transition tool does
      // the same).
      if (transition.durationSec >= accDur || transition.durationSec >= seg.durationSec) {
        throw new CompileError(
          `Transition after "${prevClip?.id}" is ${transition.durationSec}s but must be shorter than ` +
            `both adjacent clips (${accDur.toFixed(3)}s before it, ${seg.durationSec}s after). ` +
            `Shorten the transition or lengthen the clips.`,
        );
      }
      const offset = accDur - transition.durationSec; // > 0 by the guard above
      steps.push({
        label: `fold:xfade:${i}`,
        args: buildTransitionArgs({
          inputA: accPath,
          inputB: seg.output,
          output: out,
          kind: transition.kind,
          durationSec: transition.durationSec,
          offsetSec: offset,
          hasAudio: true,
        }),
        output: out,
        textFiles: [],
      });
      accDur = accDur + seg.durationSec - transition.durationSec;
    } else {
      steps.push({
        label: `fold:cut:${i}`,
        args: buildHardCutArgs(accPath, seg.output, out),
        output: out,
        textFiles: [],
      });
      accDur = accDur + seg.durationSec;
    }
    accPath = out;
  }

  return { steps, output: ctx.output, durationSec: accDur, ...loudnessOf(comp) };
}

function loudnessOf(comp: Composition): Pick<FfmpegPlan, 'loudness'> {
  return comp.loudness ? { loudness: { targetLufs: comp.loudness.targetLufs } } : {};
}
