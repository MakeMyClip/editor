import { resolve } from 'node:path';
import { buildTransitionArgs } from '../ffmpeg/args/transition.js';
import { quoteFilterArg } from '../ffmpeg/escape.js';
import {
  type Clip,
  type Composition,
  clipDuration,
  type Effect,
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
 * v1 scope is a single video-track sequence. Constructs that need true
 * compositing — multiple populated video/audio tracks, a non-identity per-clip
 * transform, or chromaKey (which needs a background layer) — throw a clear
 * `CompileError` rather than emitting a wrong graph.
 */

export interface MediaInfo {
  path: string;
  hasAudio: boolean;
}

export interface CompileContext {
  /** mediaId → resolved file path + whether it carries an audio stream. */
  media: Map<MediaId, MediaInfo>;
  /** Directory for intermediate segments and any generated text files. */
  dir: string;
  /** Final output file path. */
  output: string;
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

function isIdentityTransform(clip: Clip): boolean {
  const t = clip.transform;
  if (!t) return true;
  return t.scale === 1 && t.x === 0.5 && t.y === 0.5 && t.rotationDeg === 0 && t.opacity === 1;
}

/** Net speed multiplier from the effect stack (1 when none). */
function speedFactor(effects: Effect[]): number {
  return effects.reduce((f, e) => (e.type === 'speed' ? f * e.factor : f), 1);
}

/** The single video track to export, with v1's "no compositing yet" guards. */
function selectVideoTrack(comp: Composition): Track {
  const populatedVideo = comp.tracks.filter((t) => t.kind === 'video' && t.clips.length > 0);
  const populatedAudio = comp.tracks.filter((t) => t.kind === 'audio' && t.clips.length > 0);
  if (populatedAudio.length > 0) {
    throw new CompileError(
      'Separate audio tracks are not supported in export yet — audio comes from the video clips. Move audio onto the video track or remove the audio track.',
    );
  }
  if (populatedVideo.length === 0) {
    throw new CompileError('Nothing to export: no video track has clips.');
  }
  if (populatedVideo.length > 1) {
    throw new CompileError(
      'Multi-track overlay export is not supported yet — flatten to a single video track first.',
    );
  }
  const track = populatedVideo[0];
  if (!track) throw new CompileError('Nothing to export: no video track has clips.');
  return track;
}

function assertCompilable(clip: Clip): void {
  if (!isIdentityTransform(clip)) {
    throw new CompileError(
      `Clip "${clip.id}" has a non-identity transform — per-clip transform is not supported in export yet.`,
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

/** Translate a clip's effect stack into video/audio filter fragments, applied
 *  after the geometry/source fragments. Order: color → speed → fades. */
function effectFilters(clip: Clip, outDur: number): FilterChains {
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
      video.push(`setpts=PTS/${f}`);
      audio.push(atempoChain(f));
    }
  }

  for (const e of clip.effects) {
    if (e.type === 'fadeIn') {
      video.push(`fade=t=in:st=0:d=${e.durationSec}`);
      audio.push(`afade=t=in:st=0:d=${e.durationSec}`);
    } else if (e.type === 'fadeOut') {
      const st = Math.max(0, outDur - e.durationSec);
      video.push(`fade=t=out:st=${st}:d=${e.durationSec}`);
      audio.push(`afade=t=out:st=${st}:d=${e.durationSec}`);
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

function segPath(dir: string, index: number, clipId: string): string {
  return resolve(dir, `${SEG_PREFIX}-${index}-${clipId}.mp4`);
}

/**
 * Normalize one clip to a self-contained segment: canvas-sized video at the
 * composition fps, effects baked in, and a guaranteed stereo AAC audio track
 * (the source's, or generated silence) so the fold can always join segments.
 */
function buildSegmentStep(
  comp: Composition,
  clip: Clip,
  index: number,
  ctx: CompileContext,
): FfmpegStep {
  assertCompilable(clip);
  const outDur = outputDuration(clip);
  const { width, height, fps, background } = comp;
  const out = segPath(ctx.dir, index, clip.id);
  const { video: fx, audio: afx } = effectFilters(clip, outDur);
  const textFiles: StepSideFile[] = [];

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
    inputArgs.push('-f', 'lavfi', '-i', `color=c=${clip.color}:s=${width}x${height}:r=${fps}`);
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
    inputArgs.push('-f', 'lavfi', '-i', `color=c=${background}:s=${width}x${height}:r=${fps}`);
    inputArgs.push(
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`,
    );
    videoSource = '[0:v]';
    audioSource = '1:a';
    const textfile = resolve(ctx.dir, `${TEXT_PREFIX}-${index}-${clip.id}.txt`);
    textFiles.push({ path: textfile, content: clip.text });
    fx.unshift(drawtextFilter(textfile, clip.style));
  }

  // Geometry first: fit to canvas, pad, square pixels, lock fps. (No-op-ish for
  // generated sources that are already canvas-sized, but keeps the chain uniform.)
  const geometry = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${quoteColor(background)}`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
  ];

  const videoChain = [...geometry, ...fx].join(',');
  const audioChain = afx.length ? afx.join(',') : null;

  const filterParts = [`${videoSource}${videoChain}[v]`];
  if (audioChain) filterParts.push(`[${audioSource}]${audioChain}[a]`);

  // Map a filtergraph label ([a]) when audio went through a chain, else the bare
  // input stream specifier (0:a / 1:a) — brackets here would be read as a label.
  const audioMap = audioChain ? '[a]' : audioSource;

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

const CENTER_POS = { x: '(w-text_w)/2', y: '(h-text_h)/2' };

function drawtextFilter(
  textfile: string,
  style: { fontSize: number; color: string; background: string | null; anchor: string },
): string {
  const pos = ANCHOR_EXPR[style.anchor] ?? CENTER_POS;
  const opts = [
    `textfile=${quoteFilterArg(textfile)}`,
    `fontsize=${style.fontSize}`,
    `fontcolor=${quoteFilterArg(style.color)}`,
    `x=${quoteFilterArg(pos.x)}`,
    `y=${quoteFilterArg(pos.y)}`,
  ];
  if (style.background) {
    opts.push('box=1', `boxcolor=${quoteFilterArg(style.background)}`, 'boxborderw=12');
  }
  return `drawtext=${opts.join(':')}`;
}

const EDGE = 40;
const ANCHOR_EXPR: Record<string, { x: string; y: string }> = {
  'top-left': { x: `${EDGE}`, y: `${EDGE}` },
  'top-center': { x: '(w-text_w)/2', y: `${EDGE}` },
  'top-right': { x: `w-text_w-${EDGE}`, y: `${EDGE}` },
  'center-left': { x: `${EDGE}`, y: '(h-text_h)/2' },
  center: { x: '(w-text_w)/2', y: '(h-text_h)/2' },
  'center-right': { x: `w-text_w-${EDGE}`, y: '(h-text_h)/2' },
  'bottom-left': { x: `${EDGE}`, y: `h-text_h-${EDGE}` },
  'bottom-center': { x: '(w-text_w)/2', y: `h-text_h-${EDGE}` },
  'bottom-right': { x: `w-text_w-${EDGE}`, y: `h-text_h-${EDGE}` },
};

/** color filter `c=` rejects '#rrggbb'; normalize to 0x form, pass names through. */
function quoteColor(color: string): string {
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

export function compileTimeline(comp: Composition, ctx: CompileContext): FfmpegPlan {
  const track = selectVideoTrack(comp);
  const clips = [...track.clips].sort((a, b) => a.startSec - b.startSec);
  const transitionAfter = new Map(track.transitions.map((t) => [t.afterClipId, t]));

  const steps: FfmpegStep[] = [];

  // 1. Normalize every clip to a segment.
  const segments = clips.map((clip, i) => {
    const step = buildSegmentStep(comp, clip, i, ctx);
    steps.push(step);
    return { clip, output: step.output, durationSec: outputDuration(clip) };
  });

  // Single clip: the segment IS the result — re-target it to the final output.
  if (segments.length === 1) {
    const only = steps[0];
    if (!only) throw new CompileError('Nothing to export.');
    only.args[only.args.length - 1] = ctx.output;
    only.output = ctx.output;
    return { steps, output: ctx.output, durationSec: segments[0]?.durationSec ?? 0 };
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
    const out = isLast ? ctx.output : resolve(ctx.dir, `${FOLD_PREFIX}-${i}.mp4`);

    if (transition) {
      const offset = Math.max(0, accDur - transition.durationSec);
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

  return { steps, output: ctx.output, durationSec: accDur };
}
