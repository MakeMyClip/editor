import type { Clip, Composition, Track } from '../types.js';

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

/** Locate a clip by id, returning it plus the track it lives on. */
export function findClip(comp: Composition, clipId: string): { clip: Clip; track: Track } | null {
  for (const track of comp.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

/** The clip that starts immediately after `clip` on the same track (the one a
 *  transition after `clip` would blend into), or null if it's the last clip. */
export function nextClipOnTrack(track: Track, clip: Clip): Clip | null {
  let next: Clip | null = null;
  for (const c of track.clips) {
    if (c.startSec > clip.startSec && (next === null || c.startSec < next.startSec)) next = c;
  }
  return next;
}
