import { useEffect, useState } from 'react';

interface Exportable {
  exportable: boolean;
  blockers: string[];
}

/**
 * The monitor: the COMPOSITED frame at the playhead, rendered server-side through
 * the real export compiler (GET /api/timeline/frame) so the preview can't diverge
 * from the export. The playhead is debounced so scrubbing doesn't fire an FFmpeg
 * render per pixel, and a banner surfaces whether the document can render at all.
 */
export function Viewer({ atSec, rev }: { atSec: number; rev: number }) {
  const [debouncedAt, setDebouncedAt] = useState(atSec);
  const [frameError, setFrameError] = useState(false);
  const [status, setStatus] = useState<Exportable | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAt(atSec), 140);
    return () => clearTimeout(t);
  }, [atSec]);

  // A new frame request — clear the stale error so the <img> renders again.
  useEffect(() => {
    setFrameError(false);
  }, [debouncedAt, rev]);

  // Re-check exportability whenever the document changes.
  useEffect(() => {
    let alive = true;
    fetch('/api/timeline/exportable')
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

  const src = `/api/timeline/frame?at=${debouncedAt.toFixed(2)}&rev=${rev}`;
  const notRenderable = status !== null && !status.exportable;

  return (
    <div className="viewer">
      <div className="viewer-stage">
        {notRenderable ? (
          <div className="viewer-msg">Not renderable yet — see the reason below.</div>
        ) : frameError ? (
          <div className="viewer-msg">No frame at this point.</div>
        ) : (
          <img
            key={src}
            className="viewer-frame"
            src={src}
            alt={`Composited frame at ${debouncedAt.toFixed(2)} seconds`}
            onError={() => setFrameError(true)}
          />
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
