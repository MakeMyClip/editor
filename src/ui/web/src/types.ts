// Mirrors the shape returned by /api/session — kept in sync manually with
// src/session/types.ts because the React build isn't aware of the parent
// editor package's types.

export interface SessionEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  timestamp: string;
}

export interface Session {
  version: 1;
  entries: SessionEntry[];
}

// ─── Composition document ────────────────────────────────────────────────────
// Mirrors the shape returned by /api/timeline (src/timeline/composition.ts),
// kept in sync manually like Session above. Only the fields the UI reads.

export type ClipKind = 'media' | 'text' | 'color';

export type Fit = 'contain' | 'cover';

/** A clip's placement. Absent fields are the defaults: the canvas fit, zoom 1,
 *  centered (x/y align the picture: 0 = left/top edges together, 1 = right/bottom). */
export interface Transform {
  fit?: Fit;
  scale?: number;
  x?: number;
  y?: number;
  rotationDeg?: number;
  opacity?: number;
}

interface ClipBase {
  id: string;
  startSec: number;
  effects?: unknown[];
  transform?: Transform;
}
export interface MediaClip extends ClipBase {
  kind: 'media';
  mediaId: string;
  sourceInSec: number;
  sourceOutSec: number;
}
export interface TextClip extends ClipBase {
  kind: 'text';
  text: string;
  durationSec: number;
}
export interface ColorClip extends ClipBase {
  kind: 'color';
  color: string;
  durationSec: number;
}
export type Clip = MediaClip | TextClip | ColorClip;

export interface Transition {
  afterClipId: string;
  kind: string;
  durationSec: number;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  clips: Clip[];
  transitions: Transition[];
  muted?: boolean;
}

export interface Composition {
  version: number;
  rev: number;
  width: number;
  height: number;
  fps: number;
  background: string;
  /** How media fill the canvas unless a clip's transform says otherwise. */
  fit: Fit;
  /** Loudness the mp4 export normalizes to, or null to keep the clips' levels. */
  loudness: { targetLufs: number } | null;
  tracks: Track[];
}
