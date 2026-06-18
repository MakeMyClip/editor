/**
 * Shared optimistic-concurrency core for the workspace's revisioned JSON
 * documents (the session log and the CompositionDoc). Both files are a single
 * source of truth that more than one writer can touch — the embedded chat agent
 * and a `clip ui` request in the same process, or a CLI command run while the UI
 * is open. Without serialization a lock-free read-modify-write loses updates (the
 * original session bug); without a `rev` compare-and-swap a cross-process writer
 * can still last-writer-win.
 *
 * This factory captures that machinery ONCE so the two stores can't drift: each
 * store supplies how to `read`/`write` its state and read/set its `rev`, and gets
 * back in-process serialization + a CAS retry loop + a CAS write + a
 * parse-free overwrite. The previous design hand-rolled all of this inside the
 * session store; the doc store had none of it.
 *
 * Each call returns an INDEPENDENT store (its own `runExclusive` chain), so
 * session writes and composition writes serialize against themselves but not
 * needlessly against each other — they are different files.
 */

/** A monotonic revision counter on a persisted document. */
export interface Revisioned {
  rev: number;
}

export interface RevisionedStoreConfig<S> {
  /** Strict read: returns the parsed state, throwing on a corrupt file. */
  read: () => Promise<S>;
  /** Atomic write of a committed state. */
  write: (state: S) => Promise<void>;
  getRev: (state: S) => number;
  /** Return a copy of `state` with its `rev` set — never mutate the input. */
  withRev: (state: S, rev: number) => S;
  /**
   * Read just the rev, treating a corrupt file as rev 0 (used only by
   * `overwrite`, which is about to discard whatever is there). Defaults to
   * `getRev(read())`, i.e. corrupt files propagate — supply a tolerant reader
   * when the store needs parse-free recovery.
   */
  readRevTolerant?: () => Promise<number>;
  /** How many times `mutate` re-runs when a cross-process write is detected. */
  maxAttempts?: number;
  /** Build the store's domain-specific conflict error (e.g. SessionConflictError). */
  onConflict?: (expectedRev: number, actualRev: number) => Error;
}

export interface RevisionedStore<S> {
  /** Serialize `fn` after every prior in-process write to this store. */
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Serialized, atomic read → derive-next → write. `mutator` receives the
   * freshly-read state and returns the `next` state plus a `result`; it must be
   * free of external side effects (a detected cross-process race re-runs it).
   * A throw from `mutator` aborts immediately and propagates.
   */
  mutate: <T>(mutator: (state: S) => { next: S; result: T }) => Promise<{ result: T; state: S }>;
  /** CAS: write `state` only if the on-disk rev still equals `expectedRev`, then
   *  bump to `expectedRev + 1`; throws the conflict error otherwise. */
  writeIfUnchanged: (state: S, expectedRev: number) => Promise<S>;
  /** Replace the document WITHOUT trusting the current file to parse, advancing
   *  rev past the last readable revision (or restarting at 1 from a corrupt one). */
  overwrite: (state: S) => Promise<S>;
}

/** Default conflict error when a store does not supply its own. */
export class RevisionConflictError extends Error {
  readonly expectedRev: number;
  readonly actualRev: number;
  constructor(expectedRev: number, actualRev: number) {
    super(
      `Write rejected: expected rev ${expectedRev} but on-disk rev is ${actualRev}. ` +
        `Another writer committed first — re-read and reapply.`,
    );
    this.name = 'RevisionConflictError';
    this.expectedRev = expectedRev;
    this.actualRev = actualRev;
  }
}

export function createRevisionedStore<S>(cfg: RevisionedStoreConfig<S>): RevisionedStore<S> {
  // Floor at 1 so `mutate` always makes at least one read-modify-write pass — a
  // misconfigured `maxAttempts: 0` would otherwise skip the loop body entirely
  // and surface a meaningless (-1, -1) conflict instead of applying the mutation.
  const maxAttempts = Math.max(1, cfg.maxAttempts ?? 8);
  const conflict = cfg.onConflict ?? ((e, a) => new RevisionConflictError(e, a));

  // Every mutation runs through this promise chain, so two concurrent callers in
  // the SAME process can never interleave their read-modify-write. Reads are
  // intentionally NOT serialized: atomic writes mean a reader always sees a
  // complete file, so reads stay lock-free.
  let writeChain: Promise<unknown> = Promise.resolve();

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeChain.then(fn, fn);
    // Keep the chain alive regardless of whether `fn` resolved or rejected.
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function diskRev(): Promise<number> {
    return cfg.getRev(await cfg.read());
  }

  async function mutate<T>(
    mutator: (state: S) => { next: S; result: T },
  ): Promise<{ result: T; state: S }> {
    return runExclusive(async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const current = await cfg.read();
        const baseRev = cfg.getRev(current);

        const { next, result } = mutator(current);

        // Re-read the on-disk rev immediately before committing. In-process the
        // chain guarantees it's unchanged; a mismatch means another process wrote.
        const observed = await diskRev();
        if (observed !== baseRev) {
          if (attempt === maxAttempts) throw conflict(baseRev, observed);
          continue;
        }

        const committed = cfg.withRev(next, baseRev + 1);
        await cfg.write(committed);
        return { result, state: committed };
      }
      // Unreachable: the loop either returns or throws on the final attempt.
      throw conflict(-1, -1);
    });
  }

  async function writeIfUnchanged(state: S, expectedRev: number): Promise<S> {
    return runExclusive(async () => {
      const actualRev = await diskRev();
      if (actualRev !== expectedRev) throw conflict(expectedRev, actualRev);
      const next = cfg.withRev(state, expectedRev + 1);
      await cfg.write(next);
      return next;
    });
  }

  async function overwrite(state: S): Promise<S> {
    return runExclusive(async () => {
      const baseRev = cfg.readRevTolerant ? await cfg.readRevTolerant() : await diskRev();
      const next = cfg.withRev(state, baseRev + 1);
      await cfg.write(next);
      return next;
    });
  }

  return { runExclusive, mutate, writeIfUnchanged, overwrite };
}
