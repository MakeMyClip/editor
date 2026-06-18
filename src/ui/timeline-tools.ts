import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { appendOp } from '../session/store.js';
import { type Composition, clipEndSec, compositionDuration } from '../timeline/composition.js';
import {
  applyVerbs,
  readComposition,
  readDocOpLog,
  redoDocOp,
  undoLastDocOp,
} from '../timeline/document-store.js';
import { CompositionVerbSchema, DEFAULT_VERB_TRACK, type VerbContext } from '../timeline/verbs.js';
import { ingest } from '../tools/ingest.js';
import { resolveInput } from '../workspace.js';

/** A VerbContext wired to the real ingest tool — resolves the path, registers the
 *  media, and logs the ingest to the session so it shows up like a CLI ingest. */
export function makeVerbContext(): VerbContext {
  return {
    defaultTrack: DEFAULT_VERB_TRACK,
    ingest: async (path) => {
      const resolved = resolveInput(path);
      const result = await ingest({ path: resolved });
      await appendOp({
        tool: 'ingest',
        args: { path: resolved },
        result: result as unknown as Record<string, unknown>,
      });
      return { mediaId: result.mediaId, durationSec: result.ref.durationSec };
    },
  };
}

/** Compact, agent-readable view of the document — the textual "eyes". */
export function summarizeComposition(comp: Composition): unknown {
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

/**
 * The op-aware timeline toolset for the chat agent: edits go through the verb
 * layer → `mutateComposition`, so every agent edit lands on the SAME non-
 * destructive, undoable document the human and CLI edit — not the legacy file
 * tools that produced orphaned output files. Errors return as data so a failed
 * call doesn't abort the streaming turn.
 */
export function buildTimelineTools(): Record<string, Tool> {
  const ctx = makeVerbContext();
  const asData = (fn: () => Promise<unknown>) => async () => {
    try {
      return await fn();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    timeline_edit: tool({
      description:
        'Edit the timeline document with one or more verbs (applied atomically as a single undoable change). This is the primary way to build a video: add clips, trim, move, split, transition, etc. Returns the updated document summary.',
      inputSchema: z.object({
        verbs: z.array(CompositionVerbSchema).min(1).describe('Editing verbs to apply in order.'),
      }),
      execute: async ({ verbs }) =>
        asData(async () => {
          const { doc, ops } = await applyVerbs(verbs, ctx);
          return { applied: ops.length, document: summarizeComposition(doc) };
        })(),
    }),
    timeline_show: tool({
      description:
        'Read the current timeline document — tracks, clips, and timings. Call this to ground yourself before editing or to verify a change.',
      inputSchema: z.object({}),
      execute: async () => asData(async () => summarizeComposition(await readComposition()))(),
    }),
    timeline_undo: tool({
      description: 'Undo the most recent timeline edit.',
      inputSchema: z.object({}),
      execute: async () =>
        asData(async () => {
          const { undone, label } = await undoLastDocOp();
          return undone ? { undone: true, label } : { undone: false, message: 'Nothing to undo.' };
        })(),
    }),
    timeline_redo: tool({
      description: 'Redo the most recently undone timeline edit.',
      inputSchema: z.object({}),
      execute: async () =>
        asData(async () => {
          const { redone, label } = await redoDocOp();
          return redone ? { redone: true, label } : { redone: false, message: 'Nothing to redo.' };
        })(),
    }),
    timeline_history: tool({
      description: 'List the timeline edit history (what can be undone / redone).',
      inputSchema: z.object({}),
      execute: async () =>
        asData(async () => {
          const log = await readDocOpLog();
          return {
            canUndo: log.cursor > 0,
            canRedo: log.cursor < log.entries.length,
            entries: log.entries.map((e, i) => ({
              label: e.label,
              state: i < log.cursor ? 'applied' : 'undone',
            })),
          };
        })(),
    }),
  };
}
