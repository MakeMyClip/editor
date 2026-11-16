/** The timeline at `composition.json`; every other timeline is a short. */
export const MAIN_TIMELINE = 'main';

/** Mirrors TimelineIdSchema in src/timeline/schema.ts. */
const TIMELINE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Mirrors TimelineListing in src/timeline/document-store.ts. */
export type TimelineListing =
  | { id: string; width: number; height: number; durationSec: number; rev: number }
  | { id: string; error: string };

export function isTimelineId(id: string): boolean {
  return TIMELINE_ID.test(id);
}

/** An API path for the given timeline: every /api/timeline route reads `?timeline=`. */
export function withTimeline(path: string, timeline: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}timeline=${encodeURIComponent(timeline)}`;
}

/** `16:9`, `9:16`, `1:1`, `4:5`… from the canvas size. */
export function shapeLabel(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(width, height);
  const [w, h] = [width / d, height / d];
  return w <= 32 && h <= 32 ? `${w}:${h}` : `${width}×${height}`;
}

/** The first `short-N` no timeline uses yet. */
export function nextShortId(ids: readonly string[]): string {
  let n = 1;
  while (ids.includes(`short-${n}`)) n++;
  return `short-${n}`;
}
