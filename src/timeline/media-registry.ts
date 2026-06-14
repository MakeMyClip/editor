import { readSession } from '../session/store.js';
import type { MediaInfo } from './compile.js';
import type { MediaId } from './schema.js';

/**
 * Resolve every ingested media id to its file path + audio presence by scanning
 * the session log's `ingest` entries. The session log IS the media registry: an
 * `ingest` op records `{ mediaId, ref: { path, audio } }`, and clip `mediaId`s
 * are minted from the same absolute paths, so the map keys line up by construction.
 */
export async function buildMediaMap(): Promise<Map<MediaId, MediaInfo>> {
  const session = await readSession();
  const map = new Map<MediaId, MediaInfo>();
  for (const entry of session.entries) {
    if (entry.tool !== 'ingest') continue;
    const result = entry.result as {
      mediaId?: unknown;
      ref?: { path?: unknown; audio?: unknown };
    };
    const mediaId = result.mediaId;
    const path = result.ref?.path;
    if (typeof mediaId === 'string' && typeof path === 'string') {
      map.set(mediaId as MediaId, { path, hasAudio: result.ref?.audio != null });
    }
  }
  return map;
}
