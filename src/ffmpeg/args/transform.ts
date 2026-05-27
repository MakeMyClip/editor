export type TransformOp = 'crop' | 'rotate' | 'flip' | 'scale';

interface CommonArgs {
  input: string;
  output: string;
}

export interface CropArgs extends CommonArgs {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RotateArgs extends CommonArgs {
  /** Multiple of 90 degrees, clockwise. Use 0 only as a no-op (handled at the tool layer). */
  degrees: 90 | 180 | 270;
}

export interface FlipArgs extends CommonArgs {
  axis: 'horizontal' | 'vertical';
}

export interface ScaleArgs extends CommonArgs {
  /** Target width. Pass -1 to compute from height. Either width or height (or both) must be set. */
  width?: number;
  height?: number;
}

/**
 * `crop=W:H:X:Y` extracts a rectangle from the input. We re-encode the video
 * (cropping doesn't fit a stream-copy model) but stream-copy audio.
 */
export function buildCropArgs({ input, output, x, y, width, height }: CropArgs): string[] {
  return [
    '-y',
    '-i',
    input,
    '-vf',
    `crop=${width}:${height}:${x}:${y}`,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    output,
  ];
}

/**
 * 90/180/270 rotation built from `transpose=1` (90° CW). 180 = two CW
 * rotations chained. 270 = 90° CCW via `transpose=2`.
 */
export function buildRotateArgs({ input, output, degrees }: RotateArgs): string[] {
  const filter =
    degrees === 90 ? 'transpose=1' : degrees === 270 ? 'transpose=2' : 'transpose=1,transpose=1';
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
    '-c:a',
    'copy',
    output,
  ];
}

/** `hflip` for horizontal mirror, `vflip` for vertical mirror. */
export function buildFlipArgs({ input, output, axis }: FlipArgs): string[] {
  const filter = axis === 'horizontal' ? 'hflip' : 'vflip';
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
    '-c:a',
    'copy',
    output,
  ];
}

/**
 * `scale=W:H`. Either dimension can be -1 (auto-fit, divisible by 2) or -2
 * (auto, divisible by 2 — required by H.264). We use -2 by default so the
 * agent doesn't need to remember even-pixel constraints.
 */
export function buildScaleArgs({ input, output, width, height }: ScaleArgs): string[] {
  const w = width ?? -2;
  const h = height ?? -2;
  return [
    '-y',
    '-i',
    input,
    '-vf',
    `scale=${w}:${h}`,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    output,
  ];
}
