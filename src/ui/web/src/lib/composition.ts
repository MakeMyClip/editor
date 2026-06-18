import type { Clip, Composition } from '../types.js';

// Frontend mirror of the doc geometry helpers in src/timeline/composition.ts.
// The timeline view positions clips by their DOCUMENT extent (startSec +
// clipDuration), exactly as the schema/reducer model them.

/** On-timeline duration of a clip in seconds (source window for media, explicit
 *  duration for text/color). */
export function clipDuration(clip: Clip): number {
  return clip.kind === 'media' ? clip.sourceOutSec - clip.sourceInSec : clip.durationSec;
}

export function clipEndSec(clip: Clip): number {
  return clip.startSec + clipDuration(clip);
}

/** Latest clip end across all tracks — the composition's overall length. */
export function compositionDuration(comp: Composition): number {
  let end = 0;
  for (const track of comp.tracks) {
    for (const clip of track.clips) end = Math.max(end, clipEndSec(clip));
  }
  return end;
}

/** Short, human-readable label for a clip on the timeline. */
export function clipLabel(clip: Clip): string {
  if (clip.kind === 'media') return clip.mediaId;
  if (clip.kind === 'text') return `“${clip.text.slice(0, 20)}”`;
  return `color · ${clip.color}`;
}
