import { randomBytes } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWriteFile } from '../session/store.js';
import { createRevisionedStore, type RevisionedStore } from '../storage/revisioned-store.js';
import {
  ensureWorkspace,
  getWorkspace,
  resolveInWorkspace,
  WorkspaceBoundaryError,
} from '../workspace.js';
import {
  type Composition,
  CompositionSchema,
  compositionDuration,
  emptyComposition,
} from './composition.js';
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
import { MAIN_TIMELINE, TimelineIdSchema } from './schema.js';
import { type CompositionVerb, lowerVerbs, type VerbContext } from './verbs.js';

/*
 * A workspace holds several named timelines. `main` stays at the workspace root
 * (`composition.json` + `composition-ops.json`), so existing workspaces and older
 * `clip` versions keep working; every other timeline keeps the same two files in
 * `timelines/<id>/`. Each timeline has its own rev, write lock and undo history.
 */
const COMPOSITION_FILE = 'composition.json';
const COMPOSITION_OPS_FILE = 'composition-ops.json';
const TIMELINES_DIR = 'timelines';

/** Thrown for a malformed timeline id, or for an operation `main` can't take. */
export class TimelineIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineIdError';
  }
}

/** Thrown when a timeline other than `main` doesn't exist. Only `make_short` and
 *  `clip timeline new --timeline` create one, so a typo can't edit an empty document. */
export class NoTimelineError extends Error {
  readonly timeline: string;
  constructor(timeline: string) {
    super(
      `No timeline "${timeline}" in the workspace. List them with \`clip timeline list\` ` +
        '(timeline_show reports them too). A short gets its timeline from make_short (`clip timeline short`).',
    );
    this.name = 'NoTimelineError';
    this.timeline = timeline;
  }
}

function checkedTimelineId(timeline: string): string {
  const parsed = TimelineIdSchema.safeParse(timeline);
  if (!parsed.success) {
    throw new TimelineIdError(
      `Invalid timeline id "${timeline}". ${parsed.error.issues[0]?.message ?? ''}`.trim(),
    );
  }
  return parsed.data;
}

/** A non-main timeline's folder, checked against the workspace: `timelines/`
 *  or the folder could be a symlink out of it, and writes (temp files) and
 *  deletes act on the folder itself, not only on the files in it. */
function timelineDir(timeline: string): string {
  return resolveInWorkspace(join(TIMELINES_DIR, checkedTimelineId(timeline)));
}

function timelineFile(timeline: string, file: string): string {
  if (checkedTimelineId(timeline) === MAIN_TIMELINE) return resolve(getWorkspace(), file);
  timelineDir(timeline);
  return resolveInWorkspace(join(TIMELINES_DIR, timeline, file));
}

export function compositionPath(timeline: string = MAIN_TIMELINE): string {
  return timelineFile(timeline, COMPOSITION_FILE);
}

export function compositionOpsPath(timeline: string = MAIN_TIMELINE): string {
  return timelineFile(timeline, COMPOSITION_OPS_FILE);
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
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

/** The stored document, or null when the timeline has none yet. */
async function readStoredComposition(timeline: string): Promise<Composition | null> {
  await ensureWorkspace();
  const path = compositionPath(timeline);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if (isMissingFile(err)) return null;
    throw err;
  }
  try {
    return CompositionSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new CompositionCorruptError(path, { cause: err });
  }
}

/** The document an edit starts from. A missing `main` is an empty document (a
 *  fresh workspace); any other missing timeline is an error unless the edit
 *  `create`s it. */
async function readForEdit(timeline: string, create: boolean): Promise<Composition> {
  const comp = await readStoredComposition(timeline);
  if (comp) return comp;
  if (create || timeline === MAIN_TIMELINE) return emptyComposition();
  throw new NoTimelineError(timeline);
}

/** Read a timeline's document (default `main`). Throws `NoTimelineError` for a
 *  timeline other than `main` that doesn't exist. */
export async function readComposition(timeline: string = MAIN_TIMELINE): Promise<Composition> {
  return readForEdit(timeline, false);
}

export async function writeComposition(
  comp: Composition,
  timeline: string = MAIN_TIMELINE,
): Promise<void> {
  await atomicWriteFile(compositionPath(timeline), `${JSON.stringify(comp, null, 2)}\n`);
}

/** On-disk rev, treating a corrupt or missing file as rev 0 — a deliberate
 *  overwrite is about to replace it anyway. Other read errors still propagate. */
async function readCompositionRevTolerant(timeline: string): Promise<number> {
  try {
    return (await readStoredComposition(timeline))?.rev ?? 0;
  } catch (err) {
    if (err instanceof CompositionCorruptError) return 0;
    throw err;
  }
}

// Serialization + compare-and-swap, shared with the session store (see
// `storage/revisioned-store.ts`) so co-editing a timeline (the agent + `clip ui`)
// can't silently lose updates. One store per timeline, so each has its own lock.
const stores = new Map<string, RevisionedStore<Composition>>();

function storeFor(timeline: string): RevisionedStore<Composition> {
  const id = checkedTimelineId(timeline);
  let store = stores.get(id);
  if (!store) {
    store = createRevisionedStore<Composition>({
      read: () => readComposition(id),
      write: (comp) => writeComposition(comp, id),
      getRev: (comp) => comp.rev,
      withRev: (comp, rev) => ({ ...comp, rev }),
      readRevTolerant: () => readCompositionRevTolerant(id),
      onConflict: (expectedRev, actualRev) => new CompositionConflictError(expectedRev, actualRev),
    });
    stores.set(id, store);
  }
  return store;
}

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
async function readDocOpLogFile(timeline: string): Promise<DocOpLog> {
  await ensureWorkspace();
  let raw: string;
  try {
    raw = await readFile(compositionOpsPath(timeline), 'utf-8');
  } catch (err: unknown) {
    if (isMissingFile(err)) return emptyDocOpLog(0);
    throw err;
  }
  try {
    return parseDocOpLog(JSON.parse(raw));
  } catch {
    return emptyDocOpLog(0);
  }
}

async function writeDocOpLog(log: DocOpLog, timeline: string): Promise<void> {
  await atomicWriteFile(compositionOpsPath(timeline), serializeDocOpLog(log));
}

/** The op-log reconciled against the current document rev — the trustworthy view
 *  of undo/redo state (drops history left inconsistent by a crash). Both reads run
 *  inside the store's exclusive section so an interleaved IN-PROCESS commit can't
 *  make a consistent log momentarily read as empty (cross-process reads stay
 *  best-effort, as everywhere in this store). */
export async function readDocOpLog(timeline: string = MAIN_TIMELINE): Promise<DocOpLog> {
  return storeFor(timeline).runExclusive(async () => {
    const docRev = (await readComposition(timeline)).rev;
    return reconcile(await readDocOpLogFile(timeline), docRev);
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
  timeline: string,
  create: boolean,
  derive: (
    doc: Composition,
    log: DocOpLog,
  ) => { doc: Composition; log: DocOpLog; result: T } | null,
): Promise<{ doc: Composition; result: T } | null> {
  return storeFor(timeline).runExclusive(async () => {
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
      const current = await readForEdit(timeline, create);
      const log = reconcile(await readDocOpLogFile(timeline), current.rev);
      const derived = derive(current, log);
      if (derived === null) return null;

      const observed = (await readForEdit(timeline, create)).rev;
      if (observed !== current.rev) {
        if (attempt === MAX_COMMIT_ATTEMPTS) {
          throw new CompositionConflictError(current.rev, observed);
        }
        continue;
      }

      const nextRev = current.rev + 1;
      const committedDoc = { ...derived.doc, rev: nextRev };
      const committedLog = { ...derived.log, rev: nextRev };
      await writeDocOpLog(committedLog, timeline);
      await writeComposition(committedDoc, timeline);
      return { doc: committedDoc, result: derived.result };
    }
    throw new CompositionConflictError(-1, -1);
  });
}

/**
 * Read → apply ops → write, returning the new composition, and record the batch
 * (with its computed inverse) to the op-log so the edit is undoable. Serialized +
 * rev compare-and-swap via the shared revisioned store, so the agent and the UI
 * can co-edit without lost updates. An empty batch is a true no-op. `timeline`
 * defaults to `main`; `create` lets the edit start a timeline that doesn't exist
 * yet (from an empty document) instead of throwing `NoTimelineError`.
 */
export async function mutateComposition(
  ops: CompositionOp[],
  opts?: { expectedBaseRev?: number; timeline?: string; create?: boolean },
): Promise<Composition> {
  const timeline = opts?.timeline ?? MAIN_TIMELINE;
  const create = opts?.create ?? false;
  if (ops.length === 0) return readForEdit(timeline, create);
  const committed = await commitDocAndLog(timeline, create, (current, log) => {
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
  return committed ? committed.doc : readForEdit(timeline, create);
}

/**
 * Lower a batch of editing VERBS to ops and apply them as ONE undoable edit — the
 * op-aware mutation path the agent and `clip ui` share. Lowering (which ingests
 * files and mints ids) runs outside the write lock; `mutateComposition` then
 * validates, applies, and records the ops (so the edit lands in the undo stack).
 * Returns the new document and the ops that were applied. Edits `timeline`
 * (default `main`), which must exist unless the batch starts with `make_short`.
 */
export async function applyVerbs(
  verbs: CompositionVerb[],
  ctx: VerbContext,
  timeline: string = MAIN_TIMELINE,
): Promise<{ doc: Composition; ops: CompositionOp[]; warnings: string[] }> {
  const create = verbs[0]?.verb === 'make_short';
  let warnings: string[] = [];
  const editCtx: VerbContext = {
    ...ctx,
    timeline,
    warn: (message) => warnings.push(message),
  };
  // The default append point (`trackEnd`) is baked from the snapshot we lower
  // against, so if another in-process writer commits between the read and the
  // apply, re-lower against the fresh doc rather than land overlapping clips. A
  // retry re-runs the impure lowering (it may re-`ingest`), which is acceptable
  // on the rare conflict path. Retry to the same cap as the inner commit loop so
  // a burst of N concurrent edits each re-lower and land instead of the (N-cap)
  // tail silently losing to a `CompositionConflictError`.
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const current = await readForEdit(timeline, create);
    warnings = [];
    const ops = await lowerVerbs(current, verbs, editCtx);
    try {
      const doc = await mutateComposition(ops, {
        expectedBaseRev: current.rev,
        timeline,
        create,
      });
      return { doc, ops, warnings };
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
export async function undoLastDocOp(timeline: string = MAIN_TIMELINE): Promise<{
  undone: boolean;
  doc: Composition;
  label: string | null;
}> {
  const committed = await commitDocAndLog(timeline, false, (current, log) => {
    const step = undoLog(log);
    if (!step) return null;
    return { doc: applyOps(current, step.entry.inverse), log: step.log, result: step.entry.label };
  });
  if (!committed) return { undone: false, doc: await readComposition(timeline), label: null };
  return { undone: true, doc: committed.doc, label: committed.result };
}

/** Redo the most recently undone edit (re-apply its forward ops), moving the
 *  cursor forward. `redone: false` when there is nothing to redo. */
export async function redoDocOp(timeline: string = MAIN_TIMELINE): Promise<{
  redone: boolean;
  doc: Composition;
  label: string | null;
}> {
  const committed = await commitDocAndLog(timeline, false, (current, log) => {
    const step = redoLog(log);
    if (!step) return null;
    return { doc: applyOps(current, step.entry.forward), log: step.log, result: step.entry.label };
  });
  if (!committed) return { redone: false, doc: await readComposition(timeline), label: null };
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
  timeline: string = MAIN_TIMELINE,
): Promise<Composition> {
  const committed = await storeFor(timeline).writeIfUnchanged(comp, expectedRev);
  await writeDocOpLog(emptyDocOpLog(committed.rev), timeline);
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
async function overwriteDocAndResetLog(comp: Composition, timeline: string): Promise<Composition> {
  return storeFor(timeline).runExclusive(async () => {
    const baseRev = await readCompositionRevTolerant(timeline);
    const committed: Composition = { ...comp, rev: baseRev + 1 };
    await writeDocOpLog(emptyDocOpLog(committed.rev), timeline);
    await writeComposition(committed, timeline);
    return committed;
  });
}

/**
 * Recovery primitive: replace composition.json WITHOUT trusting the current file
 * to parse (so it works precisely when the live file is the corrupt one being
 * recovered). Resets undo history — a recovered document has none — and advances
 * `rev` so a stale log can never collide with the new revision.
 */
export function overwriteComposition(
  comp: Composition = emptyComposition(),
  timeline: string = MAIN_TIMELINE,
): Promise<Composition> {
  return overwriteDocAndResetLog(comp, timeline);
}

/** Start a fresh timeline (`clip timeline new`): replace the document, clear undo
 *  history, and advance `rev` past the previous one (never reuse a rev). Creates
 *  `timeline` when it doesn't exist yet. */
export function resetComposition(
  comp: Composition = emptyComposition(),
  timeline: string = MAIN_TIMELINE,
): Promise<Composition> {
  return overwriteDocAndResetLog(comp, timeline);
}

// ─── the workspace's timelines ───────────────────────────────────────────────

/** A timeline in the workspace, or one whose document can't be read. */
export type TimelineListing =
  | { id: string; width: number; height: number; durationSec: number; rev: number }
  | { id: string; error: string };

/** `main` first, then every `timelines/<id>/` holding a document, by id. A
 *  document that can't be read is listed with its error instead of failing the
 *  list; a `timelines/` folder that leads out of the workspace is refused. */
export async function listTimelines(): Promise<TimelineListing[]> {
  await ensureWorkspace();
  const listed: TimelineListing[] = [];
  for (const id of [MAIN_TIMELINE, ...(await timelineFolders())]) {
    try {
      const comp = await readStoredComposition(id);
      if (!comp && id !== MAIN_TIMELINE) continue;
      const doc = comp ?? emptyComposition();
      listed.push({
        id,
        width: doc.width,
        height: doc.height,
        durationSec: Math.round(compositionDuration(doc) * 1000) / 1000,
        rev: doc.rev,
      });
    } catch (err) {
      if (!(err instanceof CompositionCorruptError || err instanceof WorkspaceBoundaryError)) {
        throw err;
      }
      listed.push({ id, error: err.message });
    }
  }
  return listed;
}

async function timelineFolders(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(resolveInWorkspace(TIMELINES_DIR));
  } catch (err) {
    if (isMissingFile(err)) return [];
    throw err;
  }
  return names
    .filter((name) => name !== MAIN_TIMELINE && TimelineIdSchema.safeParse(name).success)
    .sort();
}

/** Remove a timeline and its undo history. `main` can't be deleted. */
export async function deleteTimeline(timeline: string): Promise<void> {
  if (checkedTimelineId(timeline) === MAIN_TIMELINE) {
    throw new TimelineIdError(
      "The main timeline can't be deleted. Start it over with `clip timeline new`.",
    );
  }
  await storeFor(timeline).runExclusive(async () => {
    try {
      if (!(await readStoredComposition(timeline))) throw new NoTimelineError(timeline);
    } catch (err) {
      // A corrupt document is deleted like any other.
      if (!(err instanceof CompositionCorruptError)) throw err;
    }
    await rm(timelineDir(timeline), { recursive: true, force: true });
  });
}
