import { useCallback, useEffect, useState } from 'react';
import { isTimelineId, MAIN_TIMELINE, type TimelineListing } from '../lib/timelines.js';

/** The timeline the page's `?timeline=` names, so a reload keeps it. */
function timelineInUrl(): string {
  const id = new URLSearchParams(window.location.search).get('timeline');
  return id && isTimelineId(id) ? id : MAIN_TIMELINE;
}

/**
 * The workspace's timelines (main and every short), polled like the document,
 * and the one being edited, kept in the page URL.
 */
export function useTimelines(intervalMs = 2000): {
  timelines: TimelineListing[];
  current: string;
  select: (id: string) => void;
  refresh: () => Promise<void>;
} {
  const [timelines, setTimelines] = useState<TimelineListing[]>([]);
  const [current, setCurrent] = useState(timelineInUrl);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/timelines');
      if (!res.ok) return;
      setTimelines(((await res.json()) as { timelines: TimelineListing[] }).timelines);
    } catch {
      // The next poll tries again; the tabs keep the last list meanwhile.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, load]);

  const select = useCallback((id: string) => {
    setCurrent(id);
    const url = new URL(window.location.href);
    if (id === MAIN_TIMELINE) url.searchParams.delete('timeline');
    else url.searchParams.set('timeline', id);
    window.history.replaceState(null, '', url);
  }, []);

  return { timelines, current, select, refresh: load };
}
