export interface CellStillArgs {
  input: string;
  output: string;
  /** Source window `[startSec, startSec + durationSec)` the still must come from. */
  startSec: number;
  durationSec: number;
  /** The first or the last frame in the window. No file is written if it holds none. */
  pick: 'first' | 'last';
  cellWidth: number;
  cellHeight: number;
}

/**
 * One still from a source window, fitted and letterboxed to exactly the cell
 * size in one pixel format, so every still in a sheet matches (FFmpeg resets a
 * filter graph, and with it the tile buffer, when an image sequence changes
 * size or format mid-stream). `select` keeps only frames inside the window
 * (source time, relative to the seek), so neither frame-rate rounding nor a
 * sparse source can hand back a frame from outside the clip; input `-t` just
 * stops the read a second later instead of decoding to the end of the file.
 */
export function buildCellStillArgs({
  input,
  output,
  startSec,
  durationSec,
  pick,
  cellWidth,
  cellHeight,
}: CellStillArgs): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(startSec),
    '-t',
    String(durationSec + 1),
    '-i',
    input,
    // The first video stream, the one export renders.
    '-map',
    '0:v:0',
    ...(pick === 'first' ? ['-frames:v', '1'] : ['-update', '1']),
    '-vf',
    `select='lt(t,${durationSec})',` +
      `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2`,
    '-pix_fmt',
    'yuvj420p',
    '-q:v',
    '4',
    '-an',
    output,
  ];
}

export interface ContactSheetArgs {
  /** printf-style pattern of numbered, same-sized stills, e.g. `/dir/f-%03d.jpg`. */
  framesPattern: string;
  frameCount: number;
  columns: number;
  output: string;
}

/** Tile numbered stills into one JPEG, left to right then top to bottom. */
export function buildContactSheetArgs({
  framesPattern,
  frameCount,
  columns,
  output,
}: ContactSheetArgs): string[] {
  const rows = Math.ceil(frameCount / columns);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    '1',
    '-i',
    framesPattern,
    '-vf',
    `tile=${columns}x${rows}`,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    output,
  ];
}
