import { z } from 'zod';
import { buildSilenceDetectArgs } from '../ffmpeg/args/silence-detect.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { computeKeepRegions, parseSilences } from '../tools/silence-remove.js';
import { checkExportable, type MediaInfo, speedFactor } from './compile.js';
import {
  type Composition,
  findClip,
  type MediaClip,
  makeClipId,
  type Track,
} from './composition.js';
import { applyOp, type CompositionOp, type SourceRange } from './ops.js';
import type { MediaId } from './schema.js';

/**
 * Doc-native silence removal. FFmpeg's `silencedetect` analyzes a media clip's
 * audio, and the result is ONE `silenceCut` op that keeps the speech, so the
 * cut lands in the op-log and a single undo restores the clip. FFmpeg only
 * decides the op here; nothing renders from it.
 */

export const SensitivitySchema = z
  .number()
  .min(0)
  .max(1)
  .describe(
    'How aggressively to cut, 0..1. Higher counts louder sound as silence and cuts shorter pauses. Default 0.5.',
  );

export const DEFAULT_SENSITIVITY = 0.5;

/** Audio kept on each side of a cut so word onsets and tails aren't clipped. */
const SPEECH_PAD_SEC = 0.1;
/** Sound between two silences shorter than this is a click or breath, not
 *  speech, and is cut with them. */
const MIN_SOUND_SEC = 0.1;
/** A cut shorter than this isn't worth a jump cut; the pause is kept. */
const MIN_CUT_SEC = 0.2;

interface Region {
  start: number;
  end: number;
}

function roundMicros(sec: number): number {
  return Math.round(sec * 1e6) / 1e6;
}

/** Thrown when a clip can't be analyzed or would be cut to nothing. */
export class SilenceAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SilenceAnalysisError';
  }
}

/**
 * Map the one sensitivity knob onto silencedetect's two parameters. 0.5 matches
 * the legacy `silence_remove` defaults (-30 dB, 0.5 s); 0 is -40 dB / 1 s and
 * 1 is -20 dB / 0.25 s.
 */
export function sensitivityToDetect(sensitivity: number): {
  noiseDb: number;
  minSilenceSec: number;
} {
  const s = SensitivitySchema.parse(sensitivity);
  return {
    noiseDb: Math.round((-40 + 20 * s) * 10) / 10,
    minSilenceSec: Math.round(0.25 ** s * 1000) / 1000,
  };
}

export interface SilenceCut {
  clipId: string;
  /** Silences silencedetect reported in the clip's window. */
  silenceCount: number;
  /** Source windows kept, in order. */
  keepRegions: SourceRange[];
  /** Timeline seconds the cut removes. */
  removedSec: number;
  /** The edit to apply, or null when there is nothing to cut. */
  op: CompositionOp | null;
}

function locateMediaClip(
  comp: Composition,
  clipId: string,
): { track: Track; index: number; clip: MediaClip } {
  const found = findClip(comp, clipId);
  if (!found) {
    throw new SilenceAnalysisError(
      `No clip "${clipId}" in the timeline. Run \`clip timeline show\` to list clip ids.`,
    );
  }
  const { track, index, clip } = found;
  if (clip.kind !== 'media') {
    throw new SilenceAnalysisError(
      `Clip "${clipId}" is a ${clip.kind} clip; silence removal needs a media clip with audio.`,
    );
  }
  return { track, index, clip };
}

/**
 * Turn silencedetect stderr for a media clip's source window into the
 * `silenceCut` op. Pure: `mintId` supplies the ids of the second and later
 * sub-clips. Throws `SilenceAnalysisError` when nothing would be kept, or when
 * the cut would stop an exportable timeline from exporting.
 */
export function planSilenceCut(
  comp: Composition,
  clipId: string,
  silencedetectStderr: string,
  opts: { media: Map<MediaId, MediaInfo>; mintId?: () => string },
): SilenceCut {
  const mintId = opts.mintId ?? makeClipId;
  const { track, index, clip } = locateMediaClip(comp, clipId);
  const durationSec = clip.sourceOutSec - clip.sourceInSec;
  const silences = parseSilences(silencedetectStderr);
  // Times are window-relative; FFmpeg can report an end just past the window.
  const clamped = silences
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(durationSec, s.end) }))
    .filter((s) => s.end > s.start);
  // With no silence the whole window is sound, however short the clip.
  const sounds =
    clamped.length === 0
      ? [{ start: 0, end: durationSec }]
      : computeKeepRegions(clamped, durationSec).filter((k) => k.end - k.start >= MIN_SOUND_SEC);
  const keeps: Region[] = [];
  for (const sound of sounds) {
    const start = Math.max(0, sound.start - SPEECH_PAD_SEC);
    const end = Math.min(durationSec, sound.end + SPEECH_PAD_SEC);
    const prev = keeps.at(-1);
    if (prev && start - prev.end < MIN_CUT_SEC) prev.end = Math.max(prev.end, end);
    else keeps.push({ start: start < MIN_CUT_SEC ? 0 : start, end });
  }
  const lastKeep = keeps.at(-1);
  if (lastKeep && durationSec - lastKeep.end < MIN_CUT_SEC) lastKeep.end = durationSec;
  if (keeps.length === 0) {
    throw new SilenceAnalysisError(
      `Clip "${clip.id}" is all silence at this sensitivity, so nothing would be kept. Lower the sensitivity or remove the clip.`,
    );
  }

  // Export rejects a transition that isn't shorter than the clip it leads into,
  // so keep the pauses after a first region too short for the incoming one.
  const prev = track.clips[index - 1];
  const incoming = prev && track.transitions.find((t) => t.afterClipId === prev.id);
  const minFirstSec = incoming ? incoming.durationSec * speedFactor(clip.effects) : 0;
  while (keeps.length > 1) {
    const [first, next] = keeps;
    if (!first || !next || first.end - first.start > minFirstSec) break;
    first.end = next.end;
    keeps.splice(1, 1);
  }

  // Regions touching the window edges snap to the clip's exact in/out points;
  // interior times (always at least MIN_CUT_SEC inside) drop float noise.
  const keepRegions: SourceRange[] = keeps.map((k) => ({
    sourceInSec: k.start === 0 ? clip.sourceInSec : roundMicros(clip.sourceInSec + k.start),
    sourceOutSec: k.end >= durationSec ? clip.sourceOutSec : roundMicros(clip.sourceInSec + k.end),
  }));
  const kept = keepRegions.reduce((sum, r) => sum + (r.sourceOutSec - r.sourceInSec), 0);
  const first = keepRegions[0];
  const isWholeClip =
    keepRegions.length === 1 &&
    first?.sourceInSec === clip.sourceInSec &&
    first.sourceOutSec === clip.sourceOutSec;

  const op: CompositionOp | null = isWholeClip
    ? null
    : {
        op: 'silenceCut',
        clipId: clip.id,
        keepRegions,
        newClipIds: keepRegions.slice(1).map(() => mintId()),
      };

  // The merge above covers the common case; anything else the shorter clip
  // breaks (a lone short region, an outgoing transition when the clip opens the
  // track) is caught by the compiler itself. The dir only names unwritten paths.
  if (op && checkExportable(comp, opts.media, '.').exportable) {
    const after = checkExportable(applyOp(comp, op), opts.media, '.');
    if (!after.exportable) {
      throw new SilenceAnalysisError(
        `Cutting these pauses would stop the timeline from exporting: ${after.blockers.join(' ')} ` +
          'Lower the sensitivity, or shorten or remove the transition.',
      );
    }
  }

  return {
    clipId: clip.id,
    silenceCount: silences.length,
    keepRegions,
    removedSec: Math.round((durationSec - kept) * 1000) / 1000,
    op,
  };
}

export interface SilenceAnalysisContext {
  /** mediaId → file path + audio presence (see `buildMediaMap`). */
  media: Map<MediaId, MediaInfo>;
  sensitivity?: number;
  mintId?: () => string;
}

/** Run silencedetect over `clipId`'s source window and plan the cut. */
export async function analyzeSilence(
  comp: Composition,
  clipId: string,
  ctx: SilenceAnalysisContext,
): Promise<SilenceCut> {
  const { clip } = locateMediaClip(comp, clipId);
  const info = ctx.media.get(clip.mediaId);
  if (!info) {
    throw new SilenceAnalysisError(`No media registered for "${clip.mediaId}" (clip "${clipId}").`);
  }
  if (!info.hasAudio) {
    throw new SilenceAnalysisError(`Clip "${clipId}" has no audio stream to detect silence in.`);
  }

  const { noiseDb, minSilenceSec } = sensitivityToDetect(ctx.sensitivity ?? DEFAULT_SENSITIVITY);
  const { stderr } = await runFfmpeg(
    buildSilenceDetectArgs({
      input: info.path,
      startSec: clip.sourceInSec,
      durationSec: clip.sourceOutSec - clip.sourceInSec,
      noiseDb,
      minSilenceSec,
    }),
  );
  return planSilenceCut(comp, clipId, stderr, { media: ctx.media, mintId: ctx.mintId });
}
