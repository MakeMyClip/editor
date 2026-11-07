import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCellStillArgs, buildContactSheetArgs } from '../ffmpeg/args/contact-sheet.js';
import { buildPeakVolumeArgs } from '../ffmpeg/args/volume-detect.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { type MediaInfo, speedFactor, videoLayers } from './compile.js';
import {
  type Clip,
  type Composition,
  clipDuration,
  clipEndSec,
  type MediaClip,
} from './composition.js';
import type { MediaId } from './schema.js';

/**
 * A review pass over the timeline for an agent that can't hear or see its own
 * cuts: find every hard cut, check the audio on each side of it, and tile the
 * frames on each side into one contact sheet. A join that clips a word comes
 * back as a flagged line, and a bad visual jump as a picture. Read-only:
 * nothing here edits the document.
 */

/** Same tolerance as the export compiler's abut check. */
const ABUT_EPSILON = 1e-4;
/** Audio measured on each side of a cut. */
export const CUT_EDGE_SEC = 0.06;
/** A peak above this at a cut edge means the cut lands in sound, not a pause. */
export const SOUND_PEAK_DB = -30;
/** Floor for digital silence, which FFmpeg reports as -inf (not JSON-safe). */
const SILENCE_FLOOR_DB = -120;
/** Cuts drawn on one sheet; any beyond are still in the report. */
const MAX_SHEET_CUTS = 12;
const CELL = { width: 320, height: 180 } as const;
/** Source read at a clip edge to find its first or last frame; a sparser
 *  source falls back to reading the whole clip. */
const EDGE_FRAME_WINDOW_SEC = 1;

/** Thrown when a cut can't be reviewed (e.g. its media isn't registered). */
export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface CutPoint {
  trackId: string;
  /** Timeline time of the cut. */
  atSec: number;
  outClipId: string;
  inClipId: string;
}

export interface CutCheck extends CutPoint {
  /** Peak at the end of the outgoing clip, dBFS; null when that side has no audio. */
  outPeakDb: number | null;
  /** Peak at the start of the incoming clip, dBFS; null when that side has no audio. */
  inPeakDb: number | null;
  flagged: boolean;
  reason: string | null;
}

export interface CutReport {
  cuts: CutCheck[];
  flagged: number;
}

export interface CutSheet {
  path: string;
  /** Cuts drawn, two frames each: the outgoing clip's last frame, then the incoming clip's first. */
  cuts: number;
  /** True when there were more media-to-media cuts than one sheet holds. */
  truncated: boolean;
}

/** Measures a source window's peak level in dBFS, or null when it has no audio. */
export type PeakMeter = (
  input: string,
  startSec: number,
  durationSec: number,
) => Promise<number | null>;

/** Hard cuts on every track: abutting clips with no transition between them.
 *  Text tracks over the picture (captions) are skipped: their joins aren't cuts. */
export function hardCuts(comp: Composition): CutPoint[] {
  const cuts: CutPoint[] = [];
  const overlays = new Set(videoLayers(comp).overlays);
  for (const track of comp.tracks) {
    if (overlays.has(track)) continue;
    const clips = [...track.clips].sort((a, b) => a.startSec - b.startSec);
    const blended = new Set(track.transitions.map((t) => t.afterClipId));
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1];
      const cur = clips[i];
      if (!prev || !cur || blended.has(prev.id)) continue;
      const end = clipEndSec(prev);
      if (Math.abs(cur.startSec - end) > ABUT_EPSILON) continue;
      cuts.push({ trackId: track.id, atSec: end, outClipId: prev.id, inClipId: cur.id });
    }
  }
  return cuts;
}

export function classifyCut(
  outPeakDb: number | null,
  inPeakDb: number | null,
): { flagged: boolean; reason: string | null } {
  const outLoud = outPeakDb !== null && outPeakDb > SOUND_PEAK_DB;
  const inLoud = inPeakDb !== null && inPeakDb > SOUND_PEAK_DB;
  if (outLoud && inLoud) {
    return { flagged: true, reason: 'Sound on both sides: the cut may clip a word or click.' };
  }
  if (outLoud) {
    return { flagged: true, reason: 'The outgoing clip ends in sound: it may stop mid-word.' };
  }
  if (inLoud) {
    return { flagged: true, reason: 'The incoming clip starts in sound: it may start mid-word.' };
  }
  return { flagged: false, reason: null };
}

/** The source window measured at one edge of a clip, or null for generated clips. */
export function edgeWindow(
  clip: Clip,
  side: 'end' | 'start',
): { mediaId: MediaId; startSec: number; durationSec: number } | null {
  if (clip.kind !== 'media') return null;
  const durationSec = Math.min(CUT_EDGE_SEC, clip.sourceOutSec - clip.sourceInSec);
  const startSec = side === 'end' ? clip.sourceOutSec - durationSec : clip.sourceInSec;
  return { mediaId: clip.mediaId, startSec, durationSec };
}

/** `max_volume` from volumedetect stderr, in dBFS; null when absent. */
export function parseMaxVolume(stderr: string): number | null {
  const match = stderr.match(/max_volume:\s*(-?inf|-?[\d.]+) dB/);
  if (!match?.[1]) return null;
  return match[1].endsWith('inf') ? SILENCE_FLOOR_DB : Math.max(SILENCE_FLOOR_DB, Number(match[1]));
}

export const measurePeakDb: PeakMeter = async (input, startSec, durationSec) => {
  const { stderr } = await runFfmpeg(buildPeakVolumeArgs({ input, startSec, durationSec }));
  return parseMaxVolume(stderr);
};

function roundDb(db: number): number {
  return Math.round(db * 10) / 10;
}

function clipsById(comp: Composition): Map<string, Clip> {
  return new Map(comp.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
}

function requireMedia(media: Map<MediaId, MediaInfo>, mediaId: MediaId, clipId: string): MediaInfo {
  const info = media.get(mediaId);
  if (!info) throw new ReviewError(`No media registered for "${mediaId}" (clip "${clipId}").`);
  return info;
}

/**
 * The most the clip's own effects can leave of its level inside the measured
 * edge window, in dB, as export renders it: volume gains add up, and a linear
 * fade on that edge (export's `afade`) passes at most `window / fade` of the
 * amplitude there — less only where the fade is longer than the window. An
 * upper bound, so a short fade can't hide a clipped word.
 */
export function edgeGainDb(clip: Clip, side: 'end' | 'start'): number {
  const fadeType = side === 'end' ? 'fadeOut' : 'fadeIn';
  // Fades run in output time; the window is in source time. Export clamps a
  // fade to the clip's output length, so do the same.
  const speed = speedFactor(clip.effects);
  const outSec = clipDuration(clip) / speed;
  const windowOutSec = Math.min(CUT_EDGE_SEC, clipDuration(clip)) / speed;
  return clip.effects.reduce((db, e) => {
    if (e.type === 'volume') return db + 20 * Math.log10(e.gain);
    if (e.type !== fadeType) return db;
    return db + 20 * Math.log10(Math.min(1, windowOutSec / Math.min(e.durationSec, outSec)));
  }, 0);
}

/**
 * Check every hard cut's audio: the last and first `CUT_EDGE_SEC` either side,
 * at the level export renders (see `edgeGainDb`). A side whose peak tops
 * `SOUND_PEAK_DB` means the cut lands in sound — a clipped word, or a click
 * where two waveforms meet. Text and color clips, and media without audio,
 * count as no audio on their side.
 */
export async function checkCuts(
  comp: Composition,
  media: Map<MediaId, MediaInfo>,
  meter: PeakMeter = measurePeakDb,
): Promise<CutReport> {
  const byId = clipsById(comp);
  const peak = async (clipId: string, side: 'end' | 'start'): Promise<number | null> => {
    const clip = byId.get(clipId);
    const window = clip ? edgeWindow(clip, side) : null;
    if (!window) return null;
    const info = requireMedia(media, window.mediaId, clipId);
    if (!info.hasAudio || !clip) return null;
    const gainDb = edgeGainDb(clip, side);
    if (gainDb === Number.NEGATIVE_INFINITY) return SILENCE_FLOOR_DB; // muted (gain 0)
    const measured = await meter(info.path, window.startSec, window.durationSec);
    return measured === null ? null : Math.max(SILENCE_FLOOR_DB, roundDb(measured + gainDb));
  };
  const cuts: CutCheck[] = [];
  for (const cut of hardCuts(comp)) {
    const outPeakDb = await peak(cut.outClipId, 'end');
    const inPeakDb = await peak(cut.inClipId, 'start');
    cuts.push({ ...cut, outPeakDb, inPeakDb, ...classifyCut(outPeakDb, inPeakDb) });
  }
  return { cuts, flagged: cuts.filter((c) => c.flagged).length };
}

/**
 * Tile the frames on each side of every hard cut between two video sources into
 * one JPEG: one row per cut, the outgoing clip's last frame then the incoming
 * clip's first. Frames come from the source media, so per-clip effects aren't
 * shown. Returns null when there's no such cut. Stills go in a scratch folder
 * under `workDir` that is removed afterward.
 */
export async function renderCutSheet(
  comp: Composition,
  media: Map<MediaId, MediaInfo>,
  output: string,
  workDir: string,
): Promise<CutSheet | null> {
  const byId = clipsById(comp);
  const pairs: [MediaClip, MediaClip][] = [];
  for (const cut of hardCuts(comp)) {
    const out = byId.get(cut.outClipId);
    const inc = byId.get(cut.inClipId);
    if (out?.kind !== 'media' || inc?.kind !== 'media') continue;
    const hasVideo = (clip: MediaClip): boolean =>
      requireMedia(media, clip.mediaId, clip.id).hasVideo !== false;
    if (hasVideo(out) && hasVideo(inc)) pairs.push([out, inc]);
  }
  if (pairs.length === 0) return null;

  const shown = pairs.slice(0, MAX_SHEET_CUTS);
  const dir = join(workDir, `.cut-sheet-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    let frames = 0;
    /** Write the next still; false when FFmpeg found no frame (it exits cleanly). */
    /** Write the next still from `[startSec, endSec)`; false when FFmpeg found
     *  no frame there (it exits cleanly). */
    const tryStill = async (
      clip: MediaClip,
      startSec: number,
      endSec: number,
      pick: 'first' | 'last',
    ) => {
      const path = join(dir, `f-${String(frames + 1).padStart(3, '0')}.jpg`);
      await runFfmpeg(
        buildCellStillArgs({
          input: requireMedia(media, clip.mediaId, clip.id).path,
          output: path,
          startSec,
          durationSec: endSec - startSec,
          pick,
          cellWidth: CELL.width,
          cellHeight: CELL.height,
        }),
      );
      if (!existsSync(path)) return false;
      frames++;
      return true;
    };
    /** The clip's first or last frame: a short window at that edge, then the
     *  whole clip for a sparse source. A missing still would shift every later
     *  cell, so refuse instead. */
    const edgeStill = async (clip: MediaClip, pick: 'first' | 'last') => {
      const { sourceInSec: inSec, sourceOutSec: outSec } = clip;
      const near =
        pick === 'last'
          ? await tryStill(clip, Math.max(inSec, outSec - EDGE_FRAME_WINDOW_SEC), outSec, pick)
          : await tryStill(clip, inSec, Math.min(outSec, inSec + EDGE_FRAME_WINDOW_SEC), pick);
      const found =
        near ||
        (outSec - inSec > EDGE_FRAME_WINDOW_SEC && (await tryStill(clip, inSec, outSec, pick)));
      if (!found) throw new ReviewError(`No frame found in clip "${clip.id}"'s source window.`);
    };
    for (const [out, inc] of shown) {
      await edgeStill(out, 'last');
      await edgeStill(inc, 'first');
    }
    await runFfmpeg(
      buildContactSheetArgs({
        framesPattern: join(dir, 'f-%03d.jpg'),
        frameCount: frames,
        columns: 2,
        output,
      }),
    );
    return { path: output, cuts: shown.length, truncated: pairs.length > shown.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface CutReview extends CutReport {
  sheet: CutSheet | null;
  /** Why the sheet couldn't be drawn, when it couldn't; the audio report still stands. */
  sheetError: string | null;
}

/** The audio report plus the contact sheet written to `sheetPath`. A sheet
 *  FFmpeg can't draw (unusual media) doesn't cost the report. */
export async function reviewCuts(
  comp: Composition,
  media: Map<MediaId, MediaInfo>,
  sheetPath: string,
  workDir: string,
  meter: PeakMeter = measurePeakDb,
): Promise<CutReview> {
  const report = await checkCuts(comp, media, meter);
  try {
    const sheet = await renderCutSheet(comp, media, sheetPath, workDir);
    return { ...report, sheet, sheetError: null };
  } catch (err) {
    return { ...report, sheet: null, sheetError: err instanceof Error ? err.message : String(err) };
  }
}
