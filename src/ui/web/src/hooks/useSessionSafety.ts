import { useCallback, useEffect, useState } from 'react';

interface SnapshotResult {
  label: string;
  path: string;
  entryCount: number;
}

interface UndoResult {
  removedOpId?: string;
  restoredFrom?: string;
  entryCount: number;
}

/**
 * Wraps the session-safety endpoints (snapshot, undo, list snapshots).
 * Returns { snapshot, undo, snapshots, loading, error } so callers don't
 * have to juggle three separate fetch calls.
 */
export function useSessionSafety() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<string[]>([]);

  const listSnapshots = useCallback(async () => {
    try {
      const res = await fetch('/api/session/snapshots');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { snapshots: string[] };
      setSnapshots(json.snapshots);
    } catch (err) {
      // Snapshot listing is non-critical — log to console but don't show
      // an error chrome for it. The buttons still work without a list.
      console.warn('Could not list snapshots:', err);
    }
  }, []);

  useEffect(() => {
    void listSnapshots();
  }, [listSnapshots]);

  async function takeSnapshot(label?: string): Promise<SnapshotResult | null> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/session/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const json = (await res.json()) as Partial<SnapshotResult> & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return null;
      }
      await listSnapshots();
      return json as SnapshotResult;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function popOrRestore(snapshotLabel?: string): Promise<UndoResult | null> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/session/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotLabel }),
      });
      const json = (await res.json()) as Partial<UndoResult> & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return null;
      }
      return json as UndoResult;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }

  return {
    snapshots,
    takeSnapshot,
    popOrRestore,
    refresh: listSnapshots,
    loading,
    error,
  };
}
