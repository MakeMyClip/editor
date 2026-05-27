import { quoteFilterArg } from '../escape.js';

export interface ZoomPanArgs {
  input: string;
  output: string;
  fromZoom: number;
  toZoom: number;
  /** Center of the zoom in normalized [0, 1] coordinates (0.5, 0.5 = frame center). */
  centerX: number;
  centerY: number;
  /** Total output frame count over which the zoom interpolates linearly. */
  totalFrames: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

/**
 * Linear z = fromZoom + (toZoom - fromZoom) * on/totalFrames
 * where `on` is the output-frame index zoompan exposes.
 *
 * x and y are the TOP-LEFT corner of the cropped+zoomed rectangle, not
 * the center. To center the zoom on (cx, cy) at zoom Z, the top-left
 * lives at (cx*iw − iw/(2Z), cy*ih − ih/(2Z)).
 */
export function buildZoomPanArgs(args: ZoomPanArgs): string[] {
  const { input, output, fromZoom, toZoom, centerX, centerY, totalFrames, width, height, fps } =
    args;

  const dz = toZoom - fromZoom;
  const zExpr = `${fromZoom}+(${dz})*on/${totalFrames}`;
  const xExpr = `${centerX}*iw-iw/(2*zoom)`;
  const yExpr = `${centerY}*ih-ih/(2*zoom)`;

  const filter =
    `zoompan=z=${quoteFilterArg(zExpr)}` +
    `:x=${quoteFilterArg(xExpr)}` +
    `:y=${quoteFilterArg(yExpr)}` +
    `:d=${totalFrames}` +
    `:s=${width}x${height}` +
    `:fps=${fps}`;

  // zoompan-on-video is a re-encode operation. Audio stream-copies if present.
  const audioArgs = args.hasAudio ? ['-c:a', 'copy'] : [];

  return [
    '-y',
    '-i',
    input,
    '-vf',
    filter,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    ...audioArgs,
    output,
  ];
}
