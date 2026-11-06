export interface SpeechAudioArgs {
  input: string;
  output: string;
}

/**
 * The first audio stream (the one export renders) as the 16 kHz mono 16-bit
 * WAV whisper.cpp reads.
 */
export function buildSpeechAudioArgs({ input, output }: SpeechAudioArgs): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-map',
    '0:a:0',
    // Turn a late start or timestamp gaps into silence: WAV has no timestamps,
    // so without this whisper's word times would shift.
    '-af',
    'aresample=async=1:first_pts=0',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    output,
  ];
}
