import { useCallback, useEffect, useRef, useState } from 'react';
import { withTimeline } from '../lib/timelines.js';
import type { Composition } from '../types.js';

const EMPTY: Composition = {
  version: 1,
  rev: 0,
  width: 1920,
  height: 1080,
  fps: 30,
  background: 'black',
  fit: 'contain',
  loudness: null,
  tracks: [],
};

/**
 * Polls `/api/timeline` for `timeline` (the CompositionDoc — the source of truth
 * for assembled edits) every `intervalMs`. Mirrors `useSession`: returns the
 * latest doc plus loading/error state and a `refresh()` for callers that just
 * mutated it (e.g. after a verb POST) and want the view to update without
 * waiting for the poll. `missing` is set when the timeline no longer exists.
 */
export function useTimeline(
  timeline: string,
  intervalMs = 2000,
): {
  composition: Composition;
  loading: boolean;
  error: string | null;
  missing: boolean;
  refresh: () => Promise<void>;
} {
  // Kept with the timeline it belongs to, so a switch shows nothing of the last one.
  const [loaded, setLoaded] = useState<{ timeline: string; doc: Composition } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The timeline whose fetch last answered 404, so another one never inherits it.
  const [missingTimeline, setMissingTimeline] = useState<string | null>(null);
  // A response for a timeline switched away from is dropped, not shown.
  const wanted = useRef(timeline);
  wanted.current = timeline;

  const load = useCallback(async () => {
    try {
      const res = await fetch(withTimeline('/api/timeline', timeline));
      if (wanted.current !== timeline) return;
      setMissingTimeline(res.status === 404 ? timeline : null);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { document: Composition };
      if (wanted.current !== timeline) return;
      setLoaded({ timeline, doc: json.document });
      setError(null);
      setLoading(false);
    } catch (err) {
      if (wanted.current !== timeline) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, [timeline]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, load]);

  const composition = loaded?.timeline === timeline ? loaded.doc : EMPTY;
  return { composition, loading, error, missing: missingTimeline === timeline, refresh: load };
}
