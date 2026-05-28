import { useEffect, useState } from 'react';

// Module-level cache: durations don't change once we measured them (ops
// are append-only, output files are immutable). Survives across remounts
// but resets when the page reloads — that's fine; the server also caches.
const cache = new Map<string, number>();

/**
 * Reads `/api/duration/:opId` lazily for Timeline cards' scrub slider.
 * Returns `null` while loading or on failure (caller hides the slider).
 */
export function useDuration(opId: string | null): number | null {
  const [value, setValue] = useState<number | null>(() =>
    opId === null ? null : (cache.get(opId) ?? null),
  );

  useEffect(() => {
    if (opId === null) {
      setValue(null);
      return;
    }
    const cached = cache.get(opId);
    if (cached !== undefined) {
      setValue(cached);
      return;
    }
    let cancelled = false;
    fetch(`/api/duration/${opId}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ durationSec: number }>) : null))
      .then((d) => {
        if (cancelled || !d) return;
        cache.set(opId, d.durationSec);
        setValue(d.durationSec);
      })
      .catch(() => {
        // Silent fail — the card just renders without a slider.
      });
    return () => {
      cancelled = true;
    };
  }, [opId]);

  return value;
}
