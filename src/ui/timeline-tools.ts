import { appendOp } from '../session/store.js';
import {
  type Composition,
  clipEndSec,
  compositionDuration,
  findClip,
} from '../timeline/composition.js';
import { buildMediaMap } from '../timeline/media-registry.js';
import { analyzeSilence } from '../timeline/silence.js';
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
    analyzeSilence: async (comp, clipId, sensitivity) => {
      const media = await buildMediaMap();
      // Untrusted (agent/UI) input — re-check the clip's registered file is still
      // inside the workspace (it may have been swapped for a symlink since ingest).
      const clip = findClip(comp, clipId)?.clip;
      const info = clip?.kind === 'media' ? media.get(clip.mediaId) : undefined;
      if (clip?.kind === 'media' && info) {
        media.set(clip.mediaId, { ...info, path: resolveInWorkspace(info.path) });
      }
      return analyzeSilence(comp, clipId, { media, sensitivity });
    },
  };
}

export interface CompositionSummary {
  rev: number;
  durationSec: number;
  canvas: { width: number; height: number; fps: number };
  tracks: {
    id: string;
    kind: string;
    clips: { id: string; kind: string; startSec: number; endSec: number }[];
  }[];
}

/** Compact, agent-readable view of the document — the textual "eyes". */
export function summarizeComposition(comp: Composition): CompositionSummary {
  return {
    rev: comp.rev,
    durationSec: compositionDuration(comp),
    canvas: { width: comp.width, height: comp.height, fps: comp.fps },
    tracks: comp.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      clips: t.clips.map((c) => ({
        id: c.id,
        kind: c.kind,
        startSec: c.startSec,
        endSec: clipEndSec(c),
      })),
    })),
  };
}
