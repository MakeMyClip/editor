/**
 * Two-pass EBU R128 loudness normalization with FFmpeg's `loudnorm`: a measure
 * pass reads the file's integrated loudness, true peak and loudness range, and
 * an apply pass feeds those back so the gain is one linear change where it can
 * be (loudnorm falls back to dynamic when the range is 0 or too wide, or the
 * gain would break the true-peak ceiling).
 */

/** True-peak ceiling, dBTP: below 0 so lossy encoding doesn't clip. */
export const TRUE_PEAK_DB = -1.5;
/** Loudness range target, LU. Both passes use it: the measured `target_offset`
 *  is only valid for the targets it was measured with. A wider measured range
 *  makes loudnorm go dynamic, which still lands near the target. */
const LRA_TARGET = 11;

export interface LoudnormMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
  outputI: number;
  outputTp: number;
  mode: 'linear' | 'dynamic';
}

/** Measure the first audio stream; the JSON lands on stderr. */
export function buildLoudnormMeasureArgs(a: { input: string; targetLufs: number }): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    a.input,
    '-map',
    '0:a:0',
    '-af',
    `loudnorm=I=${a.targetLufs}:TP=${TRUE_PEAK_DB}:LRA=${LRA_TARGET}:print_format=json`,
    '-f',
    'null',
    '-',
  ];
}

/**
 * Normalize with the measured values. The video stream is copied, not
 * re-encoded; audio is re-encoded at 48 kHz (loudnorm works at 192 kHz inside).
 */
export function buildLoudnormApplyArgs(a: {
  input: string;
  output: string;
  targetLufs: number;
  measured: LoudnormMeasurement;
}): string[] {
  const m = a.measured;
  const filter = [
    `loudnorm=I=${a.targetLufs}`,
    `TP=${TRUE_PEAK_DB}`,
    `LRA=${LRA_TARGET}`,
    `measured_I=${m.inputI}`,
    `measured_TP=${m.inputTp}`,
    `measured_LRA=${m.inputLra}`,
    `measured_thresh=${m.inputThresh}`,
    `offset=${m.targetOffset}`,
    'linear=true',
    'print_format=json',
  ].join(':');
  return [
    '-hide_banner',
    '-nostats',
    '-y',
    '-i',
    a.input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'copy',
    '-af',
    filter,
    '-c:a',
    'aac',
    '-ar',
    '48000',
    a.output,
  ];
}

const FIELDS = {
  inputI: 'input_i',
  inputTp: 'input_tp',
  inputLra: 'input_lra',
  inputThresh: 'input_thresh',
  targetOffset: 'target_offset',
  outputI: 'output_i',
  outputTp: 'output_tp',
} as const;

/**
 * Read loudnorm's JSON block from FFmpeg's stderr. FFmpeg 6 prints it at the
 * very end and 7 before its final status lines, so find the block that holds
 * `input_i` rather than taking the last one. Values are strings; `-inf` (silent
 * or too short to measure) parses to null, as does stderr with no block.
 */
export function parseLoudnormJson(stderr: string): LoudnormMeasurement | null {
  const match = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!match) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const out: Partial<LoudnormMeasurement> = {};
  for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, string][]) {
    const value = Number(raw[field]);
    if (!Number.isFinite(value)) return null;
    out[key] = value;
  }
  out.mode = raw.normalization_type === 'linear' ? 'linear' : 'dynamic';
  return out as LoudnormMeasurement;
}
