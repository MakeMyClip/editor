/**
 * Escape a filter option value through FFmpeg's option and filtergraph parsers.
 * The graph parser consumes the outer quotes first, so option-level escapes
 * must survive it. In particular, a Windows drive colon still separates options
 * without its own escape, even inside an outer quoted filtergraph value.
 *
 * These values are passed in an argument array, not through a shell. User text
 * should still go through textfile rather than drawtext's text expansion.
 * See https://ffmpeg.org/ffmpeg-filters.html#Notes-on-filtergraph-escaping
 */
export function quoteFilterArg(value: string): string {
  const optionValue = value.replace(/[\\':]/g, (char) => `\\${char}`);
  return `'${optionValue.replace(/'/g, "'\\''")}'`;
}

/** Quote a filename for the concat demuxer's single parsing layer. */
export function quoteConcatPath(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Concat paths must not contain line breaks or NUL');
  return `'${value.replace(/'/g, "'\\''")}'`;
}
