export interface PeakVolumeArgs {
  input: string;
  /** Source window to measure, in seconds. */
  startSec: number;
  durationSec: number;
}

/**
 * Measure the first audio stream (the one export renders), normalized to stereo
 * 48 kHz as export does, over a short source window, discarding the output;
 * `volumedetect` prints `max_volume` to stderr.
 */
export function buildPeakVolumeArgs({ input, startSec, durationSec }: PeakVolumeArgs): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    String(startSec),
    '-t',
    String(durationSec),
    '-i',
    input,
    '-map',
    '0:a:0',
    '-af',
    'aformat=sample_rates=48000:channel_layouts=stereo,volumedetect',
    '-f',
    'null',
    '-',
  ];
}
