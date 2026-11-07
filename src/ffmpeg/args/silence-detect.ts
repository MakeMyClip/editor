export interface SilenceDetectArgs {
  input: string;
  /** Source window to analyze, in seconds. */
  startSec: number;
  durationSec: number;
  /** Quieter than this counts as silence. */
  noiseDb: number;
  /** Shortest quiet stretch that counts as silence. */
  minSilenceSec: number;
}

/**
 * Run `silencedetect` over one source window and discard the output; the
 * silences come back as `silence_start` / `silence_end` lines on stderr.
 * `-ss`/`-t` before `-i` restart timestamps at the window start, so the
 * reported times are window-relative, and FFmpeg closes a silence that runs
 * to the end of the window with a final `silence_end`.
 *
 * The first audio stream is analyzed because that's the one timeline export
 * renders; left to itself FFmpeg would pick the stream with the most channels.
 * It is mixed (unscaled) over a silent bed exactly as long as the window, so
 * audio that ends early, or a window past the end of the audio, reads as
 * silence. The bed goes first because `amix` takes its timing from the first
 * input: padding an empty input instead yields garbage timestamps. The bed is
 * stereo, like export's audio, so out-of-phase channels aren't downmixed into
 * silence, and `aresample` turns timestamp gaps (audio that starts late) into
 * real silence, which `amix` would otherwise close up.
 */
export function buildSilenceDetectArgs({
  input,
  startSec,
  durationSec,
  noiseDb,
  minSilenceSec,
}: SilenceDetectArgs): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    String(startSec),
    '-t',
    String(durationSec),
    '-i',
    input,
    '-filter_complex',
    `anullsrc=r=48000:cl=stereo,atrim=duration=${durationSec}[bed];` +
      '[0:a:0]aresample=async=1:first_pts=0[src];' +
      `[bed][src]amix=inputs=2:duration=first:normalize=0,` +
      `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}[out]`,
    '-map',
    '[out]',
    '-f',
    'null',
    '-',
  ];
}
