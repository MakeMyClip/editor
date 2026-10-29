/**
 * Quote a value for use as a filter option value inside an FFmpeg filtergraph
 * (`-vf` / `-filter_complex`), e.g. `textfile=${quoteFilterArg(path)}`.
 *
 * FFmpeg reads the value twice, and each read strips one layer of quoting
 * (`av_get_token`): the filtergraph parser splits on `[],;`, then the filter's
 * option parser splits on `:`. So the value is escaped for the option parser
 * first, and that result is quoted for the graph parser.
 *
 * User text should still go through `textfile=` rather than drawtext's `text=`,
 * whose content is expanded a third time.
 *
 * See https://ffmpeg.org/ffmpeg-filters.html#Notes-on-filtergraph-escaping
 *
 * @example
 *   quoteFilterArg('/tmp/x.txt')  // '/tmp/x.txt'
 *   quoteFilterArg('C:\\x.txt')   // 'C\:\\x.txt'
 *   quoteFilterArg("it's")        // 'it\'\''s'
 */
export function quoteFilterArg(value: string): string {
  return quoteToken(escapeOptionValue(value));
}

/**
 * Quote a path for one line of a concat-demuxer list (`file <quoted path>`).
 * The demuxer reads each line once, so this is a single layer of quoting, not
 * the two a filtergraph value needs.
 */
export function quoteConcatPath(path: string): string {
  if (/[\r\n\0]/.test(path)) throw new ConcatPathError(path);
  return quoteToken(path);
}

/** Thrown for a path the concat list can't hold: it has one path per line. */
export class ConcatPathError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `Can't concat ${JSON.stringify(path)}: the file name contains a line break or NUL, ` +
        `which the concat list can't represent. Rename the file and try again.`,
    );
    this.name = 'ConcatPathError';
    this.path = path;
  }
}

// The option parser trims unescaped whitespace at both ends of a value, so
// edge whitespace is escaped along with the characters it treats as syntax.
function escapeOptionValue(value: string): string {
  return value
    .replace(/[\\':]/g, '\\$&')
    .replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, (run) => run.replace(/[\s\S]/g, '\\$&'));
}

// Inside '…' nothing is special, not even a backslash, so a literal quote has
// to close the run, be escaped on its own, and reopen it.
function quoteToken(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
