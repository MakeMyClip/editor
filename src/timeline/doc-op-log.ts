import { z } from 'zod';
import { type CompositionOp, CompositionOpSchema } from './ops.js';

/**
 * The undo/redo history for a CompositionDoc — an append-only list of applied
 * op batches plus a `cursor` that marks how many are currently in effect.
 * Persisted next to the document in `composition-ops.json`, deliberately SEPARATE
 * from `composition.json` so the render input stays a clean document.
 *
 * Model (a standard undo stack):
 *  - `entries[0..cursor-1]` are applied; `entries[cursor..]` are undone and
 *    available to redo.
 *  - undo: apply `entries[cursor-1].inverse`, cursor--.
 *  - redo: apply `entries[cursor].forward`, cursor++.
 *  - a fresh edit truncates the redo tail (`entries[cursor..]`) before appending.
 *
 * `rev` mirrors the document rev the log is consistent with — the coupling that
 * lets `reconcile` detect (and conservatively discard) a log left inconsistent by
 * a crash between the two files' writes. These functions are PURE: the I/O layer
 * (document-store) reads/writes the file, mints entry ids, and applies the ops.
 *
 * Types are hand-written (`CompositionOp[]`, not the schema's inferred type) so
 * callers apply entries directly; `DocOpLogSchema` validates the persisted form.
 */
export interface DocOpLogEntry {
  id: string;
  /** Human-readable summary of the batch (e.g. "addClip+addTransition"). */
  label: string;
  /** The ops as originally applied — replayed on redo. */
  forward: CompositionOp[];
  /** The ops that undo this batch — replayed on undo. */
  inverse: CompositionOp[];
}

export interface DocOpLog {
  version: 1;
  rev: number;
  cursor: number;
  entries: DocOpLogEntry[];
}

const DocOpLogEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  forward: z.array(CompositionOpSchema),
  inverse: z.array(CompositionOpSchema),
});

export const DocOpLogSchema = z.object({
  version: z.literal(1),
  rev: z.number().int().nonnegative().default(0),
  cursor: z.number().int().nonnegative().default(0),
  entries: z.array(DocOpLogEntrySchema).default([]),
});

export function emptyDocOpLog(rev = 0): DocOpLog {
  return { version: 1, rev, cursor: 0, entries: [] };
}

/** Record a freshly-applied batch: drop any redo tail at the cursor, append the
 *  entry, and advance the cursor to the new end. */
export function recordOps(log: DocOpLog, entry: DocOpLogEntry): DocOpLog {
  const entries = log.entries.slice(0, log.cursor);
  entries.push(entry);
  return { ...log, entries, cursor: entries.length };
}

export function canUndo(log: DocOpLog): boolean {
  return log.cursor > 0;
}

export function canRedo(log: DocOpLog): boolean {
  return log.cursor < log.entries.length;
}

/** The entry an undo would reverse (apply its `inverse`) plus the log with the
 *  cursor moved back, or null if there is nothing to undo. */
export function undo(log: DocOpLog): { entry: DocOpLogEntry; log: DocOpLog } | null {
  if (!canUndo(log)) return null;
  const entry = log.entries[log.cursor - 1];
  if (!entry) return null;
  return { entry, log: { ...log, cursor: log.cursor - 1 } };
}

/** The entry a redo would re-apply (apply its `forward`) plus the log with the
 *  cursor moved forward, or null if there is nothing to redo. */
export function redo(log: DocOpLog): { entry: DocOpLogEntry; log: DocOpLog } | null {
  if (!canRedo(log)) return null;
  const entry = log.entries[log.cursor];
  if (!entry) return null;
  return { entry, log: { ...log, cursor: log.cursor + 1 } };
}

/**
 * Bring the log into agreement with the authoritative document rev. If they
 * match, the log is trusted as-is. If not, the only cause is a crash BETWEEN the
 * two files' writes — the history can no longer be safely trusted (the last
 * recorded change may or may not be reflected in the doc), so we conservatively
 * DROP it, keeping the document intact. Losing undo history after a crash is an
 * acceptable cost; replaying a stale inverse onto the wrong document is not.
 */
export function reconcile(log: DocOpLog, docRev: number): DocOpLog {
  return log.rev === docRev ? log : emptyDocOpLog(docRev);
}

/** Parse + validate a persisted log. Throws on a malformed file (the reader
 *  treats that the same as a desync: drop history, keep the doc). */
export function parseDocOpLog(raw: unknown): DocOpLog {
  return DocOpLogSchema.parse(raw) as unknown as DocOpLog;
}

export function serializeDocOpLog(log: DocOpLog): string {
  return `${JSON.stringify(log, null, 2)}\n`;
}
