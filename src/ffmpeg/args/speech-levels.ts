export interface SpeechLevelsArgs {
  input: string;
  /** Where to start measuring, in source seconds. */
  fromSec: number;
  durationSec: number;
}

/** Samples per measured frame at 16 kHz: 10 ms. */
export const LEVEL_FRAME_SAMPLES = 160;
export const LEVEL_SAMPLE_RATE = 16000;

/**
 * The RMS level of every 10 ms of a source's first audio stream over a window,
 * printed to stderr as `pts_time:…` / `lavfi.astats.Overall.RMS_level=…` lines.
 * Mono at 16 kHz is plenty to tell speech from a pause, and the window is a few
 * seconds, so it runs in well under a tenth of a second.
 */
export function buildSpeechLevelsArgs({ input, fromSec, durationSec }: SpeechLevelsArgs): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    String(fromSec),
    '-t',
    String(durationSec),
    '-i',
    input,
    '-map',
    '0:a:0',
    '-af',
    [
      // A late start or a timestamp gap becomes silence, as for transcription,
      // so frame n is always n x 10 ms after the seek point.
      `aresample=${LEVEL_SAMPLE_RATE}:async=1:first_pts=0`,
      'aformat=channel_layouts=mono',
      `asetnsamples=n=${LEVEL_FRAME_SAMPLES}:p=0`,
      'astats=metadata=1:reset=1',
      'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level',
    ].join(','),
    '-f',
    'null',
    '-',
  ];
}
