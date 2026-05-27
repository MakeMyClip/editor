import { z } from 'zod';
import { probe } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, resolveInput } from '../workspace.js';
import { concat } from './concat.js';
import { trim } from './trim.js';

export const SilenceRemoveInput = z.object({
  input: z.string().min(1).describe('Source video with audio.'),
  noiseDb: z
    .number()
    .max(0)
    .default(-30)
    .describe('Noise threshold in dB. Quieter than this counts as silence. Default -30dB.'),
  minSilenceSec: z
    .number()
    .positive()
    .default(0.5)
    .describe('Minimum silence duration (sec) to count. Default 0.5.'),
});

export type SilenceRemoveInputType = z.input<typeof SilenceRemoveInput>;

export interface SilenceRemoveResult {
  path: string;
  silenceCount: number;
  keptRegionCount: number;
  durationMs: number;
}

interface SilenceRegion {
  start: number;
  end: number;
}

/**
 * Parse `silencedetect` filter output from ffmpeg stderr. Lines come in
 * pairs: `silence_start: N` followed (later) by `silence_end: M`. We pair
 * them in order; an unterminated start (e.g. silence runs to EOF) is
 * dropped since we have no end to anchor it.
 */
export function parseSilences(stderr: string): SilenceRegion[] {
  const silences: SilenceRegion[] = [];
  let currentStart: number | null = null;
  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*([-\d.]+)/);
    if (startMatch?.[1]) {
      currentStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([-\d.]+)/);
    if (endMatch?.[1] && currentStart !== null) {
      silences.push({ start: currentStart, end: Number(endMatch[1]) });
      currentStart = null;
    }
  }
  return silences;
}

/**
 * Invert a sorted, non-overlapping list of silence regions into the
 * complementary "keep" regions across [0, totalDurationSec].
 */
export function computeKeepRegions(
  silences: SilenceRegion[],
  totalDurationSec: number,
): SilenceRegion[] {
  const keeps: SilenceRegion[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) {
      keeps.push({ start: cursor, end: s.start });
    }
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < totalDurationSec) {
    keeps.push({ start: cursor, end: totalDurationSec });
  }
  return keeps;
}

export async function silenceRemove(
  rawInput: SilenceRemoveInputType,
): Promise<SilenceRemoveResult> {
  const input = SilenceRemoveInput.parse(rawInput);

  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);

  const start = Date.now();

  // Step 1: probe duration (also confirms input has audio — silenceremove
  // on a video-only file is meaningless and we want a clear error early).
  const probed = await probe(resolvedInput);
  if (!probed.audio) {
    throw new Error(`silence_remove needs an audio stream; ${resolvedInput} has none.`);
  }

  // Step 2: detect silences via the silencedetect audio filter. We discard
  // the rendered output (-f null -) and parse the diagnostic lines ffmpeg
  // emits to stderr.
  const detect = await runFfmpeg([
    '-i',
    resolvedInput,
    '-af',
    `silencedetect=noise=${input.noiseDb}dB:d=${input.minSilenceSec}`,
    '-f',
    'null',
    '-',
  ]);
  const silences = parseSilences(detect.stderr);
  const keeps = computeKeepRegions(silences, probed.durationSec);

  if (keeps.length === 0) {
    throw new Error('Entire input was detected as silence — nothing to keep.');
  }

  // Step 3: trim each keep region in parallel (stream-copy, fast).
  const trimmed = await Promise.all(
    keeps.map((k) =>
      trim({
        input: resolvedInput,
        start: String(k.start),
        end: String(k.end),
      }),
    ),
  );

  // Step 4: concat. If there's only one keep region (no silence to remove
  // or a degenerate case), the single trim IS the result.
  if (trimmed.length === 1) {
    const only = trimmed[0];
    if (!only) {
      throw new Error('Unexpected: parallel trim returned an empty slot.');
    }
    return {
      path: only.path,
      silenceCount: silences.length,
      keptRegionCount: 1,
      durationMs: Date.now() - start,
    };
  }

  const result = await concat({ inputs: trimmed.map((t) => t.path) });
  return {
    path: result.path,
    silenceCount: silences.length,
    keptRegionCount: keeps.length,
    durationMs: Date.now() - start,
  };
}
