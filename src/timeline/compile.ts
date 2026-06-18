import { resolve } from 'node:path';
import { buildPreviewFrameArgs } from '../ffmpeg/args/preview.js';
import { buildTransitionArgs } from '../ffmpeg/args/transition.js';
import { quoteFilterArg } from '../ffmpeg/escape.js';
import {
  type Clip,
  type Composition,
  clipDuration,
  clipEndSec,
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
 * v1 scope is a single video-track sequence of abutting clips. Constructs that
 * need true compositing — multiple populated video/audio tracks, a non-identity
 * per-clip transform, chromaKey (which needs a background layer), or timeline
 * gaps/overlaps — throw a clear `CompileError` rather than emitting a wrong graph.
 *
 * Known interaction (v1): a per-clip fadeOut/fadeIn placed on the SAME boundary
 * as a transition double-darkens, since the xfade already supplies the blend over
 * that window. Prefer one or the other on a given cut; fixing the overlap is a
 * follow-up.
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
    // Clamp the fade to the clip so a fade longer than the clip still reaches
    // full black/silence within the available window instead of ramping partway.
    if (e.type === 'fadeIn') {
      const d = Math.min(e.durationSec, outDur);
      video.push(`fade=t=in:st=0:d=${d}`);
      audio.push(`afade=t=in:st=0:d=${d}`);
    } else if (e.type === 'fadeOut') {
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
    inputArgs.push(
      '-f',
      'lavfi',
      '-i',
      `color=c=${quoteColor(clip.color)}:s=${width}x${height}:r=${fps}`,
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
      `color=c=${quoteColor(background)}:s=${width}x${height}:r=${fps}`,
    );
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
  // Always normalize audio to a uniform stereo/48k layout BEFORE any effects, so
  // the fold's concat/acrossfade can't silently downmix when a source clip is
  // mono (and so every segment exposes a real [a] output). aformat is a harmless
  // no-op for the already-stereo silence sources. This makes the "guaranteed
  // stereo AAC audio" invariant real, not aspirational.
  const audioChain = ['aformat=sample_rates=48000:channel_layouts=stereo', ...afx].join(',');

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
 * Goes through the REAL segment path (`buildSegmentStep`) so the preview can't
 * diverge from what export would produce, then extracts a still from that
 * normalized segment. Two steps: encode the active clip's segment, then grab the
 * frame at the mapped offset. Runs the SAME abutting check as export, so it fails
 * (rather than guessing a clip) on an unexportable doc; throws `CompileError` past
 * the end, in a gap, or on an overlap, and inherits the v1 single-video-track /
 * no-compositing guards.
 *
 * Known v1 limits (flag, don't fix here): a frame inside a transition window
 * shows the underlying clip, not the xfade blend; `-ss` is keyframe-accurate
 * (off by up to a GOP) — fine for a thumbnail; and a long clip re-encodes a whole
 * segment to grab one frame.
 */
export function buildFrameAtPlan(
  comp: Composition,
  ctx: CompileContext,
  atSec: number,
): FfmpegPlan {
  if (atSec < 0) throw new CompileError(`Frame time ${atSec}s is before the timeline start.`);
  const track = selectVideoTrack(comp);
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

  // Encode the clip's segment exactly as export would, then extract the frame.
  const segStep = buildSegmentStep(comp, clip, index, ctx);

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

  const frameStep: FfmpegStep = {
    label: `frame:${clip.id}@${atSec}`,
    args: buildPreviewFrameArgs({ input: segStep.output, output: ctx.output, atSec: clamped }),
    output: ctx.output,
    textFiles: [],
  };

  return { steps: [segStep, frameStep], output: ctx.output, durationSec: 0 };
}

export function compileTimeline(comp: Composition, ctx: CompileContext): FfmpegPlan {
  const track = selectVideoTrack(comp);
  const clips = [...track.clips].sort((a, b) => a.startSec - b.startSec);
  const transitionAfter = new Map(track.transitions.map((t) => [t.afterClipId, t]));

  assertAbutting(clips);

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

  return { steps, output: ctx.output, durationSec: accDur };
}
