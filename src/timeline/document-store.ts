import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../session/store.js';
import { createRevisionedStore } from '../storage/revisioned-store.js';
import { ensureWorkspace, getWorkspace } from '../workspace.js';
import { type Composition, CompositionSchema, emptyComposition } from './composition.js';
import { applyOps, type CompositionOp } from './ops.js';

const COMPOSITION_FILE = 'composition.json';

export function compositionPath(): string {
  return resolve(getWorkspace(), COMPOSITION_FILE);
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

/**
 * Read → apply ops → write, returning the new composition. Now serialized + rev
 * compare-and-swap via the shared revisioned store, so the agent and the UI can
 * co-edit composition.json without lost updates (writes were already atomic).
 * `applyOp`'s return type is unchanged in this slice — the reversible op-log /
 * `{ doc, opsApplied }` change lands in the next PR.
 */
export async function mutateComposition(ops: CompositionOp[]): Promise<Composition> {
  const { state } = await docStore.mutate((current) => {
    const next = applyOps(current, ops);
    return { next, result: next };
  });
  return state;
}

/**
 * Compare-and-swap write: persist `comp` only if the on-disk `rev` still equals
 * `expectedRev`, then bump to `expectedRev + 1`. Throws `CompositionConflictError`
 * if another writer committed first — the optimistic-concurrency primitive the
 * co-editing UI builds on.
 */
export function writeCompositionIfUnchanged(
  comp: Composition,
  expectedRev: number,
): Promise<Composition> {
  return docStore.writeIfUnchanged(comp, expectedRev);
}

/**
 * Recovery primitive: replace composition.json atomically and WITHOUT trusting
 * the current file to parse (so it works precisely when the live file is the
 * corrupt one being recovered), advancing `rev` past the last readable revision.
 */
export function overwriteComposition(comp: Composition = emptyComposition()): Promise<Composition> {
  return docStore.overwrite(comp);
}

export async function resetComposition(
  comp: Composition = emptyComposition(),
): Promise<Composition> {
  await writeComposition(comp);
  return comp;
}
