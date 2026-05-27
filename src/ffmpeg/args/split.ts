/**
 * Build the two ffmpeg invocations needed to split a clip at `atSec` into
 * a `before` and `after` half. Returns a tuple of arg arrays — one per
 * subprocess call — so the tool can run them in parallel.
 *
 * Stream-copy (`-c copy`) means the split is keyframe-accurate rather than
 * frame-exact. Users who need exact splits can re-encode the input via
 * `render` first.
 */
export function buildSplitArgs(
  input: string,
  atSec: number,
  beforeOutput: string,
  afterOutput: string,
): [string[], string[]] {
  // Both calls use `-ss` BEFORE `-i` (fast input-seek). `-c copy` requires
  // input-seek; output-seek would force a decode.
  const beforeArgs = [
    '-y',
    '-ss',
    '0',
    '-to',
    String(atSec),
    '-i',
    input,
    '-c',
    'copy',
    beforeOutput,
  ];
  // No `-to` on the after-half: ffmpeg reads through to EOF.
  const afterArgs = ['-y', '-ss', String(atSec), '-i', input, '-c', 'copy', afterOutput];
  return [beforeArgs, afterArgs];
}
