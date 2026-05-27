export interface AdjustArgs {
  input: string;
  output: string;
  /** -1 (black) to 1 (white). 0 = unchanged. */
  brightness?: number;
  /** 0 to 4. 1 = unchanged. */
  contrast?: number;
  /** 0 (grayscale) to 3. 1 = unchanged. */
  saturation?: number;
  /** 0 (mute) to 2. 1 = unchanged. */
  volume?: number;
}

/**
 * Build the `eq=` filter expression for the video adjustments that are set.
 * Returns null if no video adjustments are requested.
 */
function buildEqExpr(args: AdjustArgs): string | null {
  const parts: string[] = [];
  if (args.brightness !== undefined && args.brightness !== 0) {
    parts.push(`brightness=${args.brightness}`);
  }
  if (args.contrast !== undefined && args.contrast !== 1) {
    parts.push(`contrast=${args.contrast}`);
  }
  if (args.saturation !== undefined && args.saturation !== 1) {
    parts.push(`saturation=${args.saturation}`);
  }
  return parts.length > 0 ? `eq=${parts.join(':')}` : null;
}

export function buildAdjustArgs(args: AdjustArgs): string[] {
  const eqExpr = buildEqExpr(args);
  const hasVolume = args.volume !== undefined && args.volume !== 1;

  const videoArgs = eqExpr
    ? ['-vf', eqExpr, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'copy'];

  const audioArgs = hasVolume ? ['-af', `volume=${args.volume}`, '-c:a', 'aac'] : ['-c:a', 'copy'];

  return ['-y', '-i', args.input, ...videoArgs, ...audioArgs, args.output];
}
