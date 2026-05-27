import { useEffect, useState } from 'react';
import type { Session } from '../types.js';

const EMPTY: Session = { version: 1, entries: [] };

/**
 * Polls `/api/session` every `intervalMs`. Returns the latest session plus
 * loading/error state. v0.1 uses polling; v0.2 will swap to SSE when the
 * session changes more frequently than once-per-call.
 */
export function useSession(intervalMs = 2000): {
  session: Session;
  loading: boolean;
  error: string | null;
} {
  const [session, setSession] = useState<Session>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/session');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Session;
        if (!cancelled) {
          setSession(json);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    void load();
    const timer = window.setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return { session, loading, error };
}
