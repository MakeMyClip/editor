export interface ConcatArgs {
  /** Path to a concat-demuxer list file (each line `file '<path>'`). */
  listFile: string;
  output: string;
}

export function buildConcatArgs({ listFile, output }: ConcatArgs): string[] {
  // `-f concat` selects the concat demuxer (file-level, not the stream-level
  // filter). `-safe 0` allows absolute paths in the list (the default `1`
  // rejects them for security reasons that don't apply inside our workspace).
  // `-c copy` stream-copies all streams — fast and lossless. Falls over with
  // a clear error if input codecs don't match; the agent can re-encode first.
  return ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output];
}
