import type { Composition, Fit } from '../types.js';
import { withTimeline } from './timelines.js';

/** A timeline editing verb (mirrors CompositionVerb in src/timeline/verbs.ts).
 *  Loosely typed at the field level — the server validates with Zod, which is the
 *  real guardrail, so the UI only has to get the verb name + shape roughly right. */
export type Verb =
  | { verb: 'trim'; clipId: string; sourceInSec?: number; sourceOutSec?: number }
  | { verb: 'move'; clipId: string; startSec?: number; toTrack?: string }
  | { verb: 'split'; clipId: string; atSec: number }
  | { verb: 'remove'; clipId: string }
  | { verb: 'remove_silence'; clipId: string; sensitivity?: number }
  | { verb: 'cut_words'; clipId: string; fromIndex: number; toIndex: number; transcriptId: string }
  | { verb: 'remove_retakes'; clipId: string; transcriptId?: string }
  | {
      verb: 'caption_speech';
      clipId?: string;
      maxWords?: number;
      anchor?: string;
      color?: string;
      background?: string | null;
    }
  | {
      verb: 'reframe';
      aspect?: string;
      width?: number;
      height?: number;
      fit?: Fit;
      x?: number;
      y?: number;
    }
  | {
      verb: 'set_framing';
      clipId: string;
      fit?: Fit | 'inherit';
      scale?: number;
      x?: number;
      y?: number;
      reset?: boolean;
    }
  | { verb: 'set_loudness'; targetLufs: number | null }
  | {
      verb: 'transition';
      afterClipId: string;
      kind?: string;
      durationSec?: number;
      track?: string;
    }
  | {
      verb: 'make_short';
      ranges: { clipId: string; fromIndex: number; toIndex: number; transcriptId?: string }[];
      source?: string;
      x?: number;
    };

/**
 * POST editing verbs to /api/timeline/verbs for `timeline` — the same op-aware,
 * undoable path the agent and CLI use. Throws with the server's message on a
 * 4xx/5xx (e.g. a 422 for a bad clip reference or a 403 for a workspace-boundary
 * violation) so the caller can surface it. `applied` is the op count; 0 means the
 * verbs changed nothing (e.g. remove_silence found no pause). `warnings` name what
 * a verb did that may not have been meant (a short cut mid-sentence).
 */
export async function applyTimelineVerbs(
  verbs: Verb[],
  timeline: string,
): Promise<{ document: Composition; applied: number; warnings: string[] }> {
  const res = await fetch(withTimeline('/api/timeline/verbs', timeline), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verbs }),
  });
  const json = (await res.json()) as {
    document?: Composition;
    applied?: number;
    warnings?: string[];
    error?: string;
  };
  if (!res.ok || !json.document) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return { document: json.document, applied: json.applied ?? 0, warnings: json.warnings ?? [] };
}
