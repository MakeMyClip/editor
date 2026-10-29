// Ports of the FFmpeg parsing steps our escaping has to survive, so tests can
// read escaped output back the way FFmpeg does instead of comparing strings.

const WHITESPACE = ' \n\t\r';

/**
 * `av_get_token` (libavutil/avstring.c): read one token up to an unquoted,
 * unescaped character in `term`. `'…'` runs are literal, `\x` yields `x`, and
 * unescaped whitespace is trimmed from both ends.
 */
export function avGetToken(buf: string, term: string): { token: string; rest: string } {
  let p = 0;
  while (p < buf.length && WHITESPACE.includes(buf[p] as string)) p++;
  let out = '';
  let end = 0;
  while (p < buf.length && !term.includes(buf[p] as string)) {
    const c = buf[p++] as string;
    if (c === '\\' && p < buf.length) {
      out += buf[p++];
      end = out.length;
    } else if (c === "'") {
      while (p < buf.length && buf[p] !== "'") out += buf[p++];
      if (p < buf.length) {
        p++;
        end = out.length;
      }
    } else {
      out += c;
    }
  }
  let length = out.length;
  while (length > end && WHITESPACE.includes(out[length - 1] as string)) length--;
  return { token: out.slice(0, length), rest: buf.slice(p) };
}

/**
 * Parse a single-filter graph string like `drawtext=a=1:b='x'` the way
 * FFmpeg's graph parser and the filter's option parser do, returning the
 * filter name, its options, and whatever the graph parser left unread.
 */
export function parseFilter(graph: string): {
  name: string;
  options: Record<string, string>;
  rest: string;
} {
  const name = avGetToken(graph, '=,;[');
  if (!name.rest.startsWith('=')) return { name: name.token, options: {}, rest: name.rest };
  const opts = avGetToken(name.rest.slice(1), '[],;');
  const options: Record<string, string> = {};
  let buf = opts.token;
  while (buf.length > 0) {
    const eq = buf.indexOf('=');
    const key = buf.slice(0, eq);
    const value = avGetToken(buf.slice(eq + 1), ':');
    options[key] = value.token;
    buf = value.rest.startsWith(':') ? value.rest.slice(1) : value.rest;
  }
  return { name: name.token, options, rest: opts.rest };
}

/** The path on one concat-demuxer list line (`file <token>`). */
export function parseConcatLine(line: string): string {
  if (!line.startsWith('file ')) throw new Error(`Not a concat file line: ${line}`);
  return avGetToken(line.slice('file '.length), ' \t\r\n').token;
}
