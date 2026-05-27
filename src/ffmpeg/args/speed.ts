export interface SpeedArgs {
  input: string;
  output: string;
  /** Multiplier. 2 = double speed, 0.5 = half (slow-mo). Use 1 only with reverse=true. */
  factor: number;
  reverse: boolean;
  hasAudio: boolean;
}

/**
 * `atempo` only accepts factors in [0.5, 2.0]. For anything outside, chain
 * multiple `atempo` calls together (factor × factor × … = total). We pick
 * 0.5 or 2.0 for each link to consume the largest possible chunk; the final
 * link mops up the remainder.
 *
 * @example
 *   buildAtempoChain(4)     → 'atempo=2.0,atempo=2.0'
 *   buildAtempoChain(0.125) → 'atempo=0.5,atempo=0.5,atempo=0.5'
 *   buildAtempoChain(3)     → 'atempo=2.0,atempo=1.5'
 *   buildAtempoChain(1)     → '' (no-op)
 */
export function buildAtempoChain(factor: number): string {
  const links: string[] = [];
  let remaining = factor;
  // `>= 2` (rather than `> 2`) means exact factor=2 emits the canonical
  // 'atempo=2.0' link and the remainder check below short-circuits — without
  // this we'd emit 'atempo=2' (JS number stringification drops trailing .0).
  while (remaining >= 2) {
    links.push('atempo=2.0');
    remaining /= 2;
  }
  while (remaining <= 0.5 && remaining !== 1) {
    links.push('atempo=0.5');
    remaining *= 2;
  }
  if (Math.abs(remaining - 1) > 0.0001) {
    links.push(`atempo=${remaining}`);
  }
  return links.join(',');
}

export function buildSpeedArgs(args: SpeedArgs): string[] {
  const { input, output, factor, reverse, hasAudio } = args;

  // Video filter: optional reverse, then setpts. setpts divides the
  // presentation timestamp by the factor — factor>1 compresses time
  // (faster playback), factor<1 stretches it (slow-mo).
  const videoChain = [reverse ? 'reverse' : null, factor !== 1 ? `setpts=PTS/${factor}` : null]
    .filter((v): v is string => v !== null)
    .join(',');
  const videoFilter = `[0:v]${videoChain}[v]`;

  // Audio filter: optional areverse, then the atempo chain.
  const audioChain = hasAudio
    ? [reverse ? 'areverse' : null, buildAtempoChain(factor) || null]
        .filter((v): v is string => v !== null && v !== '')
        .join(',')
    : '';
  const audioFilter = hasAudio && audioChain ? `;[0:a]${audioChain}[a]` : '';

  const filterComplex = `${videoFilter}${audioFilter}`;

  const mappings = hasAudio && audioChain ? ['-map', '[v]', '-map', '[a]'] : ['-map', '[v]'];
  const audioCodec = hasAudio && audioChain ? ['-c:a', 'aac'] : [];

  return [
    '-y',
    '-i',
    input,
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
    ...audioCodec,
    output,
  ];
}
