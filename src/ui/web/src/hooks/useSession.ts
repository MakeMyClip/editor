import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../types.js';

const EMPTY: Session = { version: 1, entries: [] };

/**
 * Polls `/api/session` every `intervalMs`. Returns the latest session plus
 * loading/error state and a `refresh()` function for callers that just
 * mutated the session (e.g. after a successful tool POST) and want the
 * list to update without waiting for the next poll.
 */
export function useSession(intervalMs = 2000): {
  session: Session;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [session, setSession] = useState<Session>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // useCallback keeps the reference stable so the effect's deps are honest
  // and the setInterval doesn't tear down on every render.
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/session');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Session;
      setSession(json);
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

  return { session, loading, error, refresh: load };
}
