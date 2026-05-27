export interface PreviewFrameArgs {
  input: string;
  output: string;
  /** Timecode (in seconds) to extract the frame from. */
  atSec: number;
}

export function buildPreviewFrameArgs({ input, output, atSec }: PreviewFrameArgs): string[] {
  // `-ss` BEFORE `-i` is the fast (input-seek) form — ffmpeg seeks to the
  // nearest keyframe before reading any packets. Accuracy is keyframe-level
  // (sub-second to a few seconds depending on the source), but for a preview
  // thumbnail that's fine and ~100x faster than the accurate output-seek form.
  //
  // -q:v 2 is high-quality JPEG (range 1-31, lower is better; 2 is a
  // common sweet-spot used by many tools).
  // -an skips audio decoding — irrelevant for a still frame.
  return ['-y', '-ss', String(atSec), '-i', input, '-vframes', '1', '-q:v', '2', '-an', output];
}
