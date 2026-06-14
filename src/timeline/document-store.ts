import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../session/store.js';
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

/**
 * Read → apply ops → write, returning the new composition. The CLI drives this
 * sequentially (one process per command), so it needs no in-process lock; the
 * single-writer concurrency the session store carries lands here when the UI and
 * agent co-edit the doc (a later phase). Writes are already atomic.
 */
export async function mutateComposition(ops: CompositionOp[]): Promise<Composition> {
  const next = applyOps(await readComposition(), ops);
  await writeComposition(next);
  return next;
}

export async function resetComposition(
  comp: Composition = emptyComposition(),
): Promise<Composition> {
  await writeComposition(comp);
  return comp;
}
