export type AddAudioMode = 'mix' | 'replace';

export interface AddAudioArgs {
  input: string;
  audio: string;
  output: string;
  mode: AddAudioMode;
  /** Volume multiplier for the overlay audio. 1.0 = unchanged, 0.5 = half, 2 = double. */
  audioVolume: number;
  /** When the overlay audio starts (seconds from start of video). */
  startSec: number;
}

export function buildAddAudioArgs(args: AddAudioArgs): string[] {
  const { input, audio, output, mode, audioVolume, startSec } = args;

  if (mode === 'replace') {
    // Map video from input #0, audio from input #1. -shortest stops when the
    // shorter stream ends — so if the audio is longer than the video, we
    // truncate it; if it's shorter, the rest of the video has no audio.
    return [
      '-y',
      '-i',
      input,
      '-i',
      audio,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-shortest',
      output,
    ];
  }

  // Mix mode: keep [0:a], lower [1:a] via volume filter, optionally delay it,
  // then amix the two with `duration=first` so the output duration matches
  // the original video (the overlay is allowed to outlive or fall short).
  const startMs = Math.round(startSec * 1000);
  const volumeStage = `[1:a]volume=${audioVolume}[ov]`;
  const delayStage = startMs > 0 ? `;[ov]adelay=${startMs}|${startMs}[ovd]` : '';
  const overlayStream = startMs > 0 ? 'ovd' : 'ov';
  const mixStage = `;[0:a][${overlayStream}]amix=inputs=2:duration=first:dropout_transition=0[a]`;
  const filterComplex = `${volumeStage}${delayStage}${mixStage}`;

  return [
    '-y',
    '-i',
    input,
    '-i',
    audio,
    '-filter_complex',
    filterComplex,
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    output,
  ];
}
