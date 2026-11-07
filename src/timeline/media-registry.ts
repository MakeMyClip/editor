import { readSession } from '../session/store.js';
import type { MediaInfo } from './compile.js';
import { type MediaId, type MediaRef, MediaRefSchema } from './schema.js';

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
      ref?: { path?: unknown; audio?: unknown; video?: unknown };
    };
    const mediaId = result.mediaId;
    const path = result.ref?.path;
    if (typeof mediaId === 'string' && typeof path === 'string') {
      // An entry without a `video` key leaves video presence unknown.
      const hasVideo = result.ref && 'video' in result.ref ? result.ref.video != null : undefined;
      map.set(mediaId as MediaId, { path, hasAudio: result.ref?.audio != null, hasVideo });
    }
  }
  return map;
}

/**
 * Every ingested media id with its full probed reference (duration, stream
 * sizes and rates) — what an interchange export describes each source with.
 * An ingest entry whose ref doesn't parse is skipped, like a missing one.
 */
export async function buildMediaRefs(): Promise<Map<MediaId, MediaRef>> {
  const session = await readSession();
  const map = new Map<MediaId, MediaRef>();
  for (const entry of session.entries) {
    if (entry.tool !== 'ingest') continue;
    const result = entry.result as { mediaId?: unknown; ref?: unknown };
    const ref = MediaRefSchema.safeParse(result.ref);
    if (typeof result.mediaId === 'string' && ref.success) {
      map.set(result.mediaId as MediaId, ref.data);
    }
  }
  return map;
}
