import type { Composition } from '../types.js';

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
      verb: 'transition';
      afterClipId: string;
      kind?: string;
      durationSec?: number;
      track?: string;
    };

/**
 * POST editing verbs to /api/timeline/verbs — the same op-aware, undoable path
 * the agent and CLI use. Throws with the server's message on a 4xx/5xx (e.g. a
 * 422 for a bad clip reference or a 403 for a workspace-boundary violation) so
 * the caller can surface it. `applied` is the op count; 0 means the verbs changed
 * nothing (e.g. remove_silence found no pause).
 */
export async function applyTimelineVerbs(
  verbs: Verb[],
): Promise<{ document: Composition; applied: number }> {
  const res = await fetch('/api/timeline/verbs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verbs }),
  });
  const json = (await res.json()) as { document?: Composition; applied?: number; error?: string };
  if (!res.ok || !json.document) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return { document: json.document, applied: json.applied ?? 0 };
}
