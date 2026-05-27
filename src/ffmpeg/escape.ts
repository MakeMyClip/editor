/**
 * Quote a value for safe use as a filter option value in an ffmpeg filter
 * graph. Wraps the value in single quotes and escapes internal backslashes
 * and single quotes per ffmpeg's filter escape rules.
 *
 * This handles the FIRST level of escaping — filter option values — which
 * is enough for paths, color names, numeric expressions, and short text
 * snippets that go directly into a `key=value` pair.
 *
 * Some filter options (notably `drawtext` `text=`) interpret their content
 * as a SECOND-level expression where additional escaping rules apply.
 * For user-provided text, route the content through `textfile=<path>`
 * instead of inlining; this function quotes the path safely while keeping
 * the text content itself out of the filter graph entirely.
 *
 * See: https://ffmpeg.org/ffmpeg-filters.html#Filtergraph-syntax-1
 *
 * @example
 *   quoteFilterArg("don't")         // "'don\\'t'"
 *   quoteFilterArg('a:b,c[d]')      // "'a:b,c[d]'"
 *   quoteFilterArg('/tmp/x.txt')    // "'/tmp/x.txt'"
 */
export function quoteFilterArg(value: string): string {
  // Order matters: escape backslashes first, otherwise the backslash we add
  // to escape a single quote would itself get re-doubled on a second pass.
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
}
