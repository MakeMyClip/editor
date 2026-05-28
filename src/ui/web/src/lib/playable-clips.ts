import type { SessionEntry } from '../types.js';

/**
 * One playable clip extracted from a session entry. `subId` distinguishes
 * the halves of a split op; everything else has a single clip and leaves
 * `subId` undefined.
 *
 * `previewOpId` is the opId we ask `/api/preview/:opId` for to render a
 * thumbnail — same as `opId` for everything except split, where we use the
 * split op for both halves (the preview endpoint takes the entry's result
 * path so it works for both).
 */
export interface PlayableClip {
  opId: string;
  subId?: 'before' | 'after';
  path: string;
  tool: string;
  label: string;
  timestamp: string;
}

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'm4v']);

function isVideoPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXT.has(ext);
}

function shortName(path: string): string {
  const base = path.split('/').pop() ?? path;
  // Strip the 8-char random prefix (`xxxxxxxx-`) that we add to import
  // filenames and tool outputs, so cards show "demo.mp4" instead of
  // "70897716-demo.mp4". Pattern is purely cosmetic — full path is in
  // the entry args / DetailPane.
  return base.replace(/^[0-9a-f]{8}-/, '');
}

/**
 * Expand one session entry into 0..n playable clips. Most ops produce one
 * (or zero, for non-video outputs); split produces two (before + after);
 * ingest's playable path lives under `result.ref.path`.
 */
export function playableClipsFrom(entry: SessionEntry): PlayableClip[] {
  // ingest stores the imported file under result.ref.path
  if (entry.tool === 'ingest') {
    const ref = entry.result.ref as { path?: unknown } | undefined;
    const path = typeof ref?.path === 'string' ? ref.path : null;
    if (path && isVideoPath(path)) {
      return [
        {
          opId: entry.id,
          path,
          tool: entry.tool,
          label: shortName(path),
          timestamp: entry.timestamp,
        },
      ];
    }
    return [];
  }

  // split produces two output paths
  if (entry.tool === 'split') {
    const before = typeof entry.result.before === 'string' ? entry.result.before : null;
    const after = typeof entry.result.after === 'string' ? entry.result.after : null;
    const clips: PlayableClip[] = [];
    if (before && isVideoPath(before)) {
      clips.push({
        opId: entry.id,
        subId: 'before',
        path: before,
        tool: entry.tool,
        label: `${shortName(before)} (before)`,
        timestamp: entry.timestamp,
      });
    }
    if (after && isVideoPath(after)) {
      clips.push({
        opId: entry.id,
        subId: 'after',
        path: after,
        tool: entry.tool,
        label: `${shortName(after)} (after)`,
        timestamp: entry.timestamp,
      });
    }
    return clips;
  }

  // Everything else: single result.path
  const path = typeof entry.result.path === 'string' ? entry.result.path : null;
  if (!path || !isVideoPath(path)) return [];
  return [
    {
      opId: entry.id,
      path,
      tool: entry.tool,
      label: shortName(path),
      timestamp: entry.timestamp,
    },
  ];
}

/** Flatten an entire session into chronological playable clips. */
export function allPlayableClips(entries: SessionEntry[]): PlayableClip[] {
  return entries.flatMap(playableClipsFrom);
}

/**
 * Compose a deterministic id for a clip — uniquely identifies a card in
 * the UI (Queue items, drag payloads). Split halves share opId so we need
 * subId to disambiguate.
 */
export function clipKey(clip: PlayableClip): string {
  return clip.subId ? `${clip.opId}#${clip.subId}` : clip.opId;
}
