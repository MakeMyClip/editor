import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../session/store.js';
import { createRevisionedStore } from '../storage/revisioned-store.js';
import { ensureWorkspace, getWorkspace } from '../workspace.js';
import { type Composition, CompositionSchema, emptyComposition } from './composition.js';
import {
  type DocOpLog,
  type DocOpLogEntry,
  emptyDocOpLog,
  parseDocOpLog,
  reconcile,
  recordOps,
  redo as redoLog,
  serializeDocOpLog,
  undo as undoLog,
} from './doc-op-log.js';
import { applyOps, applyOpsTracked, type CompositionOp } from './ops.js';
import { type CompositionVerb, lowerVerbs, type VerbContext } from './verbs.js';

const COMPOSITION_FILE = 'composition.json';
const COMPOSITION_OPS_FILE = 'composition-ops.json';

export function compositionPath(): string {
  return resolve(getWorkspace(), COMPOSITION_FILE);
}

export function compositionOpsPath(): string {
  return resolve(getWorkspace(), COMPOSITION_OPS_FILE);
}

/** Thrown when composition.json exists but cannot be parsed/validated — surfaced,
 *  never silently reset (same posture as the session store). */
export class CompositionCorruptError extends Error {
  readonly path: string;
  constructor(path: string, options?: { cause?: unknown }) {
    super(
      `Composition file is corrupt and was not loaded: ${path}. ` +
        `Remove it to start a fresh timeline (\`clip timeline new\`).`,
      options,
    );
    this.name = 'CompositionCorruptError';
    this.path = path;
  }
}

/**
 * Thrown by `writeCompositionIfUnchanged` when the on-disk `rev` no longer
 * matches the revision the caller based its edit on — another writer committed
 * in between. Re-read and reapply rather than clobber (mirrors
 * `SessionConflictError`).
 */
export class CompositionConflictError extends Error {
  readonly expectedRev: number;
  readonly actualRev: number;
  constructor(expectedRev: number, actualRev: number) {
    super(
      `Composition write rejected: expected rev ${expectedRev} but on-disk rev is ${actualRev}. ` +
        `Another writer committed first — re-read and reapply.`,
    );
    this.name = 'CompositionConflictError';
    this.expectedRev = expectedRev;
    this.actualRev = actualRev;
  }
}

export async function readComposition(): Promise<Composition> {
  await ensureWorkspace();
  let raw: string;
  try {
    raw = await readFile(compositionPath(), 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return emptyComposition();
    throw err;
  }
  try {
    return CompositionSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new CompositionCorruptError(compositionPath(), { cause: err });
  }
}

export async function writeComposition(comp: Composition): Promise<void> {
  await atomicWriteFile(compositionPath(), `${JSON.stringify(comp, null, 2)}\n`);
}

/** On-disk rev, treating a corrupt file as rev 0 — a deliberate overwrite is
 *  about to discard it anyway. Non-corruption read errors still propagate. */
async function readCompositionRevTolerant(): Promise<number> {
  try {
    return (await readComposition()).rev;
  } catch (err) {
    if (err instanceof CompositionCorruptError) return 0;
    throw err;
  }
}

// Serialization + compare-and-swap, shared with the session store (see
// `storage/revisioned-store.ts`) so co-editing the doc (the agent + `clip ui`)
// can't silently lose updates.
const docStore = createRevisionedStore<Composition>({
  read: readComposition,
  write: writeComposition,
  getRev: (comp) => comp.rev,
  withRev: (comp, rev) => ({ ...comp, rev }),
  readRevTolerant: readCompositionRevTolerant,
  onConflict: (expectedRev, actualRev) => new CompositionConflictError(expectedRev, actualRev),
});

// ─── op-log (undo/redo) ──────────────────────────────────────────────────────
//
// The undo/redo history lives in a SEPARATE file from composition.json. Each
// mutation writes the log FIRST, then the doc: a crash in between leaves the log
// "ahead", which `reconcile` safely discards on the next read. The reverse
// ordering could leave the doc ahead and replay a stale inverse onto it, so it is
// never used. doc.rev and log.rev advance together so `reconcile` can spot the
// crash window.

const MAX_COMMIT_ATTEMPTS = 8;

function makeDocOpId(): string {
  return `dop_${randomBytes(4).toString('hex')}`;
}

function labelForOps(ops: CompositionOp[]): string {
  return ops.map((o) => o.op).join('+') || 'edit';
}

/** Read the raw op-log file. Missing OR corrupt → an empty log: undo history is a
 *  convenience, never worth failing a read for. The caller reconciles it against
 *  the authoritative document rev. */
async function readDocOpLogFile(): Promise<DocOpLog> {
  await ensureWorkspace();
  let raw: string;
  try {
    raw = await readFile(compositionOpsPath(), 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return emptyDocOpLog(0);
    throw err;
  }
  try {
    return parseDocOpLog(JSON.parse(raw));
  } catch {
    return emptyDocOpLog(0);
  }
}

async function writeDocOpLog(log: DocOpLog): Promise<void> {
  await atomicWriteFile(compositionOpsPath(), serializeDocOpLog(log));
}

/** The op-log reconciled against the current document rev — the trustworthy view
 *  of undo/redo state (drops history left inconsistent by a crash). Both reads run
 *  inside the store's exclusive section so an interleaved IN-PROCESS commit can't
 *  make a consistent log momentarily read as empty (cross-process reads stay
 *  best-effort, as everywhere in this store). */
export async function readDocOpLog(): Promise<DocOpLog> {
  return docStore.runExclusive(async () => {
    const docRev = (await readComposition()).rev;
    return reconcile(await readDocOpLogFile(), docRev);
  });
}

/**
 * Serialized commit of a coupled doc + op-log change. `derive` receives the
 * current doc and the reconciled log and returns the next doc + next log (+ a
 * caller result), or null for a no-op (e.g. undo with empty history). Writes the
 * log first, then the doc, both advanced to the next rev. In-process this is
 * exact (the revisioned store serializes writes); across processes a detected
 * mid-flight write re-derives and ultimately throws `CompositionConflictError`.
 * Cross-process safety is best-effort, and the window here is WIDER than the
 * single-file session store's: two atomic writes (log then doc) sit between the
 * rev re-check and the doc landing, so a colliding cross-process writer can still
 * last-writer-win. A real cross-process lock is deferred (single-process is the
 * shipping surface).
 */
async function commitDocAndLog<T>(
  derive: (
    doc: Composition,
    log: DocOpLog,
  ) => { doc: Composition; log: DocOpLog; result: T } | null,
): Promise<{ doc: Composition; result: T } | null> {
  return docStore.runExclusive(async () => {
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
      const current = await readComposition();
      const log = reconcile(await readDocOpLogFile(), current.rev);
      const derived = derive(current, log);
      if (derived === null) return null;

      const observed = (await readComposition()).rev;
      if (observed !== current.rev) {
        if (attempt === MAX_COMMIT_ATTEMPTS) {
          throw new CompositionConflictError(current.rev, observed);
        }
        continue;
      }

      const nextRev = current.rev + 1;
      const committedDoc = { ...derived.doc, rev: nextRev };
      const committedLog = { ...derived.log, rev: nextRev };
      await writeDocOpLog(committedLog);
      await writeComposition(committedDoc);
      return { doc: committedDoc, result: derived.result };
    }
    throw new CompositionConflictError(-1, -1);
  });
}

/**
 * Read → apply ops → write, returning the new composition, and record the batch
 * (with its computed inverse) to the op-log so the edit is undoable. Serialized +
 * rev compare-and-swap via the shared revisioned store, so the agent and the UI
 * can co-edit without lost updates. An empty batch is a true no-op.
 */
export async function mutateComposition(
  ops: CompositionOp[],
  opts?: { expectedBaseRev?: number },
): Promise<Composition> {
  if (ops.length === 0) return readComposition();
  const committed = await commitDocAndLog((current, log) => {
    // Optimistic-concurrency guard for callers whose ops were lowered against a
    // specific revision (e.g. `applyVerbs`, where a default append point is baked
    // from a snapshot read): if the doc moved under us, reject so the caller can
    // re-lower against the fresh state instead of committing stale positions.
    if (opts?.expectedBaseRev !== undefined && current.rev !== opts.expectedBaseRev) {
      throw new CompositionConflictError(opts.expectedBaseRev, current.rev);
    }
    const { doc, inverse } = applyOpsTracked(current, ops);
    const entry: DocOpLogEntry = {
      id: makeDocOpId(),
      label: labelForOps(ops),
      forward: ops,
      inverse,
    };
    return { doc, log: recordOps(log, entry), result: null };
  });
  return committed ? committed.doc : readComposition();
}

/**
 * Lower a batch of editing VERBS to ops and apply them as ONE undoable edit — the
 * op-aware mutation path the agent and `clip ui` share. Lowering (which ingests
 * files and mints ids) runs outside the write lock; `mutateComposition` then
 * validates, applies, and records the ops (so the edit lands in the undo stack).
 * Returns the new document and the ops that were applied.
 */
export async function applyVerbs(
  verbs: CompositionVerb[],
  ctx: VerbContext,
): Promise<{ doc: Composition; ops: CompositionOp[] }> {
  // The default append point (`trackEnd`) is baked from the snapshot we lower
  // against, so if another in-process writer commits between the read and the
  // apply, re-lower against the fresh doc rather than land overlapping clips. A
  // retry re-runs the impure lowering (it may re-`ingest`), which is acceptable
  // on the rare conflict path. Retry to the same cap as the inner commit loop so
  // a burst of N concurrent edits each re-lower and land instead of the (N-cap)
  // tail silently losing to a `CompositionConflictError`.
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const current = await readComposition();
    const ops = await lowerVerbs(current, verbs, ctx);
    try {
      const doc = await mutateComposition(ops, { expectedBaseRev: current.rev });
      return { doc, ops };
    } catch (err) {
      if (err instanceof CompositionConflictError && attempt < MAX_COMMIT_ATTEMPTS) continue;
      throw err;
    }
  }
  // Unreachable: the final attempt either returns or throws.
  throw new CompositionConflictError(-1, -1);
}

/** Undo the most recent recorded edit (apply its inverse), moving the op-log
 *  cursor back. `undone: false` when there is nothing to undo. */
export async function undoLastDocOp(): Promise<{
  undone: boolean;
  doc: Composition;
  label: string | null;
}> {
  const committed = await commitDocAndLog((current, log) => {
    const step = undoLog(log);
    if (!step) return null;
    return { doc: applyOps(current, step.entry.inverse), log: step.log, result: step.entry.label };
  });
  if (!committed) return { undone: false, doc: await readComposition(), label: null };
  return { undone: true, doc: committed.doc, label: committed.result };
}

/** Redo the most recently undone edit (re-apply its forward ops), moving the
 *  cursor forward. `redone: false` when there is nothing to redo. */
export async function redoDocOp(): Promise<{
  redone: boolean;
  doc: Composition;
  label: string | null;
}> {
  const committed = await commitDocAndLog((current, log) => {
    const step = redoLog(log);
    if (!step) return null;
    return { doc: applyOps(current, step.entry.forward), log: step.log, result: step.entry.label };
  });
  if (!committed) return { redone: false, doc: await readComposition(), label: null };
  return { redone: true, doc: committed.doc, label: committed.result };
}

/**
 * Compare-and-swap write of a WHOLE document: persist `comp` only if the on-disk
 * `rev` still equals `expectedRev`, then bump to `expectedRev + 1`. Throws
 * `CompositionConflictError` if another writer committed first.
 *
 * This is a low-level CAS primitive that carries NO recorded ops, so it RESETS
 * the undo history (the prior inverses no longer match the replaced document).
 * Undoable co-editing must go through `mutateComposition` / `undoLastDocOp` /
 * `redoDocOp`, which keep the op-log in lockstep. The reset is safe here without
 * the in-section log-first dance because this always advances rev by exactly one,
 * so a stale log can never collide with the new rev (unlike a recovery overwrite).
 */
export async function writeCompositionIfUnchanged(
  comp: Composition,
  expectedRev: number,
): Promise<Composition> {
  const committed = await docStore.writeIfUnchanged(comp, expectedRev);
  await writeDocOpLog(emptyDocOpLog(committed.rev));
  return committed;
}

/**
 * Replace the whole document and reset the op-log to empty at the new rev, both
 * inside one exclusive section. Advances `rev` past the last readable revision so
 * a fresh/recovered document NEVER reuses a rev — which also closes the window
 * where a recovery that lands on a colliding rev could match a stale log and
 * replay an inverse against the wrong document. Log-first ordering (the seeded
 * log is empty anyway, so a crash resolves to the same empty history).
 */
async function overwriteDocAndResetLog(comp: Composition): Promise<Composition> {
  return docStore.runExclusive(async () => {
    const baseRev = await readCompositionRevTolerant();
    const committed: Composition = { ...comp, rev: baseRev + 1 };
    await writeDocOpLog(emptyDocOpLog(committed.rev));
    await writeComposition(committed);
    return committed;
  });
}

/**
 * Recovery primitive: replace composition.json WITHOUT trusting the current file
 * to parse (so it works precisely when the live file is the corrupt one being
 * recovered). Resets undo history — a recovered document has none — and advances
 * `rev` so a stale log can never collide with the new revision.
 */
export function overwriteComposition(comp: Composition = emptyComposition()): Promise<Composition> {
  return overwriteDocAndResetLog(comp);
}

/** Start a fresh timeline (`clip timeline new`): replace the document, clear undo
 *  history, and advance `rev` past the previous one (never reuse a rev). */
export function resetComposition(comp: Composition = emptyComposition()): Promise<Composition> {
  return overwriteDocAndResetLog(comp);
}
