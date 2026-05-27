/**
 * Subset of ffmpeg's `xfade` transition kinds. Chosen to match the common
 * iMovie / CapCut palette without overwhelming the agent with 40+ obscure
 * options. Each one maps 1:1 to an `xfade` `transition=<name>` value.
 */
export type TransitionKind =
  | 'fade'
  | 'fadeblack'
  | 'fadewhite'
  | 'dissolve'
  | 'wipeleft'
  | 'wiperight'
  | 'wipeup'
  | 'wipedown'
  | 'slideleft'
  | 'slideright'
  | 'circleopen'
  | 'circleclose';

export interface TransitionArgs {
  inputA: string;
  inputB: string;
  output: string;
  kind: TransitionKind;
  /** How long the transition takes (seconds). */
  durationSec: number;
  /** When the transition starts in clip A (seconds). Usually `durationA - durationSec`. */
  offsetSec: number;
  /**
   * Whether both inputs have audio streams. When true we wire an
   * `acrossfade` alongside the video xfade; when false we drop audio
   * entirely from the output. Mixed-audio inputs are explicitly out of
   * scope for v0 — surface the constraint at the tool layer.
   */
  hasAudio: boolean;
}

export function buildTransitionArgs(args: TransitionArgs): string[] {
  const { inputA, inputB, output, kind, durationSec, offsetSec, hasAudio } = args;

  const videoFilter = `[0:v][1:v]xfade=transition=${kind}:duration=${durationSec}:offset=${offsetSec}[v]`;
  const audioFilter = hasAudio ? `;[0:a][1:a]acrossfade=d=${durationSec}[a]` : '';
  const filterComplex = `${videoFilter}${audioFilter}`;

  const mappings = hasAudio ? ['-map', '[v]', '-map', '[a]'] : ['-map', '[v]'];

  // Re-encoding is unavoidable for xfade (it blends frames). Audio is
  // re-encoded too when acrossfade is in play. libx264 + aac are the safe
  // defaults; -pix_fmt yuv420p ensures broad player compatibility.
  return [
    '-y',
    '-i',
    inputA,
    '-i',
    inputB,
    '-filter_complex',
    filterComplex,
    ...mappings,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac'] : []),
    output,
  ];
}
