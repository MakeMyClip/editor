import { appendOp } from '../session/store.js';
import type { Framing, MediaInfo } from '../timeline/compile.js';
import {
  type Composition,
  clipEndSec,
  compositionDuration,
  type Fit,
  findClip,
} from '../timeline/composition.js';
import { readComposition } from '../timeline/document-store.js';
import { buildMediaMap, buildMediaRefs } from '../timeline/media-registry.js';
import { measureSpeechLevels } from '../timeline/pauses.js';
import { ownFraming } from '../timeline/reframe.js';
import type { MediaId, MediaRef } from '../timeline/schema.js';
import { analyzeSilence } from '../timeline/silence.js';
import { storedTranscriptForClip } from '../timeline/transcript.js';
import { DEFAULT_VERB_TRACK, type VerbContext } from '../timeline/verbs.js';
import { ingest } from '../tools/ingest.js';
import { resolveInWorkspace } from '../workspace.js';

/** A VerbContext wired to the real ingest tool — resolves the path, registers the
 *  media, and logs the ingest to the session so it shows up like a CLI ingest.
 *  Shared by the `clip ui` verbs route and (next) the MCP server. */
export function makeVerbContext(): VerbContext {
  return {
    defaultTrack: DEFAULT_VERB_TRACK,
    ingest: async (path) => {
      // Untrusted (agent/UI) input — confine to the workspace.
      const resolved = resolveInWorkspace(path);
      const result = await ingest({ path: resolved });
      await appendOp({
        tool: 'ingest',
        args: { path: resolved },
        result: result as unknown as Record<string, unknown>,
      });
      return { mediaId: result.mediaId, durationSec: result.ref.durationSec };
    },
    readTimeline: (timeline) => readComposition(timeline),
    speechLevels: async (comp, clipId, aroundSec) => {
      const clip = findClip(comp, clipId)?.clip;
      if (clip?.kind !== 'media') return null;
      const info = (await clipConfinedMedia(comp, clipId)).get(clip.mediaId);
      return info?.hasAudio ? measureSpeechLevels(info.path, aroundSec) : null;
    },
    analyzeSilence: async (comp, clipId, sensitivity) =>
      analyzeSilence(comp, clipId, { media: await clipConfinedMedia(comp, clipId), sensitivity }),
    transcript: async (comp, clipId, transcriptId) => {
      const media = await clipConfinedMedia(comp, clipId);
      return { ...(await storedTranscriptForClip(comp, clipId, media, transcriptId)), media };
    },
  };
}

/** The media registry with the clip's registered file re-checked against the
 *  workspace: untrusted (agent/UI) input, and the file may have been swapped
 *  for a symlink since ingest. */
export async function clipConfinedMedia(
  comp: Composition,
  clipId: string,
): Promise<Map<MediaId, MediaInfo>> {
  const media = await buildMediaMap();
  const clip = findClip(comp, clipId)?.clip;
  const info = clip?.kind === 'media' ? media.get(clip.mediaId) : undefined;
  if (clip?.kind === 'media' && info) {
    media.set(clip.mediaId, { ...info, path: resolveInWorkspace(info.path) });
  }
  return media;
}

/** The media registry with every file the document uses re-checked against the
 *  workspace, for reads on behalf of untrusted (agent/UI) callers: a registered
 *  file may have been swapped for an outward symlink since ingest. */
export async function confinedMediaMap(comp: Composition): Promise<Map<MediaId, MediaInfo>> {
  const media = await buildMediaMap();
  for (const track of comp.tracks) {
    for (const clip of track.clips) {
      const info = clip.kind === 'media' ? media.get(clip.mediaId) : undefined;
      if (clip.kind === 'media' && info) {
        media.set(clip.mediaId, { ...info, path: resolveInWorkspace(info.path) });
      }
    }
  }
  return media;
}

/** The full media references, with every file the document uses re-checked
 *  against the workspace, as `confinedMediaMap` does for the render path. */
export async function confinedMediaRefs(comp: Composition): Promise<Map<MediaId, MediaRef>> {
  const refs = await buildMediaRefs();
  for (const track of comp.tracks) {
    for (const clip of track.clips) {
      const ref = clip.kind === 'media' ? refs.get(clip.mediaId) : undefined;
      if (clip.kind === 'media' && ref) {
        refs.set(clip.mediaId, { ...ref, path: resolveInWorkspace(ref.path) });
      }
    }
  }
  return refs;
}

export interface CompositionSummary {
  rev: number;
  durationSec: number;
  canvas: { width: number; height: number; fps: number; fit: Fit };
  loudness: Composition['loudness'];
  tracks: {
    id: string;
    kind: string;
    clips: { id: string; kind: string; startSec: number; endSec: number; framing?: Framing }[];
  }[];
}

/** Compact, agent-readable view of the document — the textual "eyes". */
export function summarizeComposition(comp: Composition): CompositionSummary {
  return {
    rev: comp.rev,
    durationSec: compositionDuration(comp),
    canvas: { width: comp.width, height: comp.height, fps: comp.fps, fit: comp.fit },
    loudness: comp.loudness,
    tracks: comp.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      clips: t.clips.map((c) => {
        const framing = ownFraming(comp, c);
        return {
          id: c.id,
          kind: c.kind,
          startSec: c.startSec,
          endSec: clipEndSec(c),
          ...(framing ? { framing } : {}),
        };
      }),
    })),
  };
}
