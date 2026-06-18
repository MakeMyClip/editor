import { useCallback, useEffect, useState } from 'react';
import type { Composition } from '../types.js';

const EMPTY: Composition = {
  version: 1,
  rev: 0,
  width: 1920,
  height: 1080,
  fps: 30,
  background: 'black',
  tracks: [],
};

/**
 * Polls `/api/timeline` (the CompositionDoc — the source of truth for assembled
 * edits) every `intervalMs`. Mirrors `useSession`: returns the latest doc plus
 * loading/error state and a `refresh()` for callers that just mutated it (e.g.
 * after a verb POST) and want the view to update without waiting for the poll.
 */
export function useTimeline(intervalMs = 2000): {
  composition: Composition;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [composition, setComposition] = useState<Composition>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/timeline');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { document: Composition };
      setComposition(json.document);
      setError(null);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, load]);

  return { composition, loading, error, refresh: load };
}
