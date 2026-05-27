export interface VidstabDetectArgs {
  input: string;
  /** Path where vidstabdetect writes the motion-transform file. */
  transformsFile: string;
  shakiness: number;
  accuracy: number;
}

export interface VidstabTransformArgs {
  input: string;
  output: string;
  /** Same transformsFile written by the detect pass. */
  transformsFile: string;
  smoothing: number;
  /** Crop a few percent off the edges to hide warping black borders. */
  zoom: number;
  hasAudio: boolean;
}

/**
 * Pass 1: vidstabdetect analyzes inter-frame motion and writes a .trf
 * file. `-f null -` discards the encoded output — we only want the side
 * effect (the transforms file). `-an` skips audio decoding.
 */
export function buildVidstabDetectArgs(args: VidstabDetectArgs): string[] {
  const { input, transformsFile, shakiness, accuracy } = args;
  return [
    '-y',
    '-i',
    input,
    '-vf',
    `vidstabdetect=result=${transformsFile}:shakiness=${shakiness}:accuracy=${accuracy}`,
    '-f',
    'null',
    '-an',
    '-',
  ];
}

/**
 * Pass 2: vidstabtransform reads the .trf and warps each frame. `zoom`
 * crops in slightly to hide the black borders the warp introduces;
 * `unsharp` after vidstabtransform is a vidstab idiom that compensates
 * for the slight blur warping causes.
 */
export function buildVidstabTransformArgs(args: VidstabTransformArgs): string[] {
  const { input, output, transformsFile, smoothing, zoom, hasAudio } = args;

  const filter =
    `vidstabtransform=input=${transformsFile}:smoothing=${smoothing}:zoom=${zoom}` +
    `,unsharp=5:5:0.8:3:3:0.4`;

  const audioArgs = hasAudio ? ['-c:a', 'copy'] : [];

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
