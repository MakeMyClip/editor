import { quoteFilterArg } from '../escape.js';

export interface ChromaKeyArgs {
  /** Background video (or looping image — see `backgroundIsImage`). */
  background: string;
  /** Foreground video containing the chroma color to remove. */
  foreground: string;
  output: string;
  /** Color to key out: 'green', 'blue', 'red', '#RRGGBB', or '0xRRGGBB'. */
  color: string;
  /** 0 (exact match only) … 1 (almost any color matches). 0.3 is a sensible default for green screen. */
  similarity: number;
  /** Soft-edge amount, 0 (hard) … 1 (very soft). 0.1 gives natural anti-aliasing without bleed. */
  blend: number;
  /**
   * If true the background input is a still image — we add `-loop 1` and
   * cap the output duration to the foreground's length. Without this, image
   * backgrounds would produce 1-frame outputs.
   */
  backgroundIsImage: boolean;
  /** Foreground duration in seconds. Only consulted when backgroundIsImage. */
  foregroundDurationSec: number;
  /** Take audio from foreground (true) or background (false). Defaults to background; flipped if background has none. */
  takeForegroundAudio: boolean;
  /** Whether the chosen audio source actually has audio. If not, output is video-only. */
  hasAudio: boolean;
}

export function buildChromaKeyArgs(args: ChromaKeyArgs): string[] {
  const {
    background,
    foreground,
    output,
    color,
    similarity,
    blend,
    backgroundIsImage,
    foregroundDurationSec,
    takeForegroundAudio,
    hasAudio,
  } = args;

  const filter =
    `[1:v]chromakey=color=${quoteFilterArg(color)}` +
    `:similarity=${similarity}:blend=${blend}[fg];` +
    `[0:v][fg]overlay=shortest=1[v]`;

  const inputArgs: string[] = ['-y'];
  if (backgroundIsImage) {
    inputArgs.push('-loop', '1', '-t', String(foregroundDurationSec), '-i', background);
  } else {
    inputArgs.push('-i', background);
  }
  inputArgs.push('-i', foreground);

  // Audio source: index 0 (background) or index 1 (foreground). We only wire
  // a `-map <N>:a` when the chosen source actually has an audio stream; the
  // shorter `-map` form otherwise would fail.
  const audioSourceIndex = takeForegroundAudio ? '1' : '0';
  const audioMapping = hasAudio ? ['-map', `${audioSourceIndex}:a`, '-c:a', 'aac'] : [];

  return [
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    ...audioMapping,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    output,
  ];
}
