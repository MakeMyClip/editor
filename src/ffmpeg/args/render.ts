export type RenderFormat = 'mp4' | 'mov' | 'webm';
export type RenderPreset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow';

export interface RenderArgs {
  input: string;
  output: string;
  format: RenderFormat;
  /** CRF: 0 (lossless) to 51 (worst). 23 is a sensible default for libx264. */
  crf: number;
  preset: RenderPreset;
  /** Optional max width in pixels. Preserves aspect ratio, even-pixel height. */
  maxWidth?: number;
}

export function buildRenderArgs(args: RenderArgs): string[] {
  const { input, output, format, crf, preset, maxWidth } = args;

  // `-2` in the height position tells ffmpeg "compute height preserving aspect,
  // round to the nearest even number" — H.264 requires even-pixel dimensions.
  // `min(W,iw)` prevents upscaling tiny clips when maxWidth is larger.
  const videoFilter = maxWidth ? ['-vf', `scale='min(${maxWidth},iw)':-2`] : [];

  // libvpx-vp9 uses a different control model than libx264: `-b:v 0` is what
  // enables constant-quality mode (with `-crf`). Without it vp9 does ABR.
  // Audio: opus for webm (modern), aac for mp4/mov (universal).
  const codecArgs =
    format === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-c:a', 'libopus']
      : [
          '-c:v',
          'libx264',
          '-preset',
          preset,
          '-crf',
          String(crf),
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
        ];

  return ['-y', '-i', input, ...videoFilter, ...codecArgs, output];
}
