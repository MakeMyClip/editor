import { useEffect, useRef, useState } from 'react';

interface Exportable {
  exportable: boolean;
  blockers: string[];
}

type FrameState =
  | { kind: 'loading' }
  | { kind: 'ok'; url: string }
  | { kind: 'error'; message: string };

/**
 * The monitor: the COMPOSITED frame at the playhead, rendered server-side through
 * the real export compiler (GET /api/timeline/frame) so the preview can't diverge
 * from the export. The playhead is debounced so scrubbing doesn't fire an FFmpeg
 * render per pixel, and a banner surfaces whether the document can render at all.
 */
export function Viewer({ atSec, rev }: { atSec: number; rev: number }) {
  const [debouncedAt, setDebouncedAt] = useState(atSec);
  const [status, setStatus] = useState<Exportable | null>(null);
  const [frame, setFrame] = useState<FrameState>({ kind: 'loading' });
  const liveUrl = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAt(atSec), 140);
    return () => clearTimeout(t);
  }, [atSec]);

  // Re-check exportability whenever the document changes (rev cache-busts).
  useEffect(() => {
    let alive = true;
    fetch(`/api/timeline/exportable?rev=${rev}`)
      .then((r) => r.json() as Promise<Exportable>)
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, [rev]);

  // Fetch the composited frame as a blob (not via <img src>) so a superseded
  // scrub is ABORTED instead of left rendering, and a transient 503 reads as a
  // clean message rather than a broken image. The previous frame stays on screen
  // until the next one decodes — no blank flash while FFmpeg works.
  const src = `/api/timeline/frame?at=${debouncedAt.toFixed(2)}&rev=${rev}`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(src, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setFrame({ kind: 'error', message: body?.error ?? 'Could not render this frame.' });
          return;
        }
        const url = URL.createObjectURL(await res.blob());
        if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
        liveUrl.current = url;
        setFrame({ kind: 'ok', url });
      })
      .catch((err: unknown) => {
        // A superseded scrub aborts in flight — ignore it; the next one wins.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setFrame({ kind: 'error', message: 'Could not reach the renderer.' });
      });
    return () => controller.abort();
  }, [src]);

  // Release the last blob URL on unmount.
  useEffect(
    () => () => {
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
    },
    [],
  );

  const notRenderable = status !== null && !status.exportable;

  return (
    <div className="viewer">
      <div className="viewer-stage">
        {notRenderable ? (
          <div className="viewer-msg">Not renderable yet — see the reason below.</div>
        ) : frame.kind === 'error' ? (
          <div className="viewer-msg">{frame.message}</div>
        ) : frame.kind === 'ok' ? (
          <img
            className="viewer-frame"
            src={frame.url}
            alt={`Composited frame at ${debouncedAt.toFixed(2)} seconds`}
          />
        ) : (
          <div className="viewer-msg">Rendering…</div>
        )}
      </div>
      <div className="viewer-bar">
        <span className="viewer-time">▶ {atSec.toFixed(2)}s</span>
        {notRenderable && status ? (
          <span className="viewer-blocker" title={status.blockers[0]}>
            ⚠ {status.blockers[0]}
          </span>
        ) : (
          <span className="viewer-ok">Renderable</span>
        )}
      </div>
    </div>
  );
}
