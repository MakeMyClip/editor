import { useEffect, useState } from 'react';
import { clipDuration, clipEndSec, clipLabel, compositionDuration } from '../lib/composition.js';
import type { Clip, Composition, MediaClip } from '../types.js';

const PX_PER_SEC = 90;
const GUTTER = 128; // left lane-label column width (px)
const MIN_SPAN_SEC = 6; // keep an empty/short timeline from collapsing
const THUMB_H = 48; // filmstrip thumbnail height (px) — the clip's inner height
const TARGET_THUMB_W = 72; // desired filmstrip frame slot width (px)
const MAX_THUMBS = 16; // cap thumbnails per clip to bound requests

/**
 * Read view of the CompositionDoc: a seconds ruler, one lane per track, clips
 * positioned by their document extent (startSec + clipDuration), transition
 * boundary markers, and a playhead scrubbed by an accessible range input. The
 * playhead is controlled by the parent so the clip inspector can split at it.
 */
export function DocTimeline({
  composition,
  selectedClipId,
  onSelectClip,
  playheadSec,
  onScrub,
  onExport,
  exporting,
  onUndo,
  onRedo,
}: {
  composition: Composition;
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  playheadSec: number;
  onScrub: (sec: number) => void;
  onExport: () => void;
  exporting: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const total = compositionDuration(composition);
  const spanSec = Math.max(total, MIN_SPAN_SEC);
  const laneWidth = spanSec * PX_PER_SEC;
  const ticks = Array.from({ length: Math.floor(spanSec) + 1 }, (_, i) => i);
  const hasClips = composition.tracks.some((t) => t.clips.length > 0);
  const playhead = Math.min(playheadSec, spanSec);

  // Undo/redo availability tracks the doc op-log; refetch whenever the doc moves.
  const [history, setHistory] = useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  });
  useEffect(() => {
    let alive = true;
    fetch(`/api/timeline/history?rev=${composition.rev}`)
      .then((r) => r.json() as Promise<{ canUndo: boolean; canRedo: boolean }>)
      .then((h) => {
        if (alive) setHistory(h);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [composition.rev]);

  return (
    <section className="doc-timeline">
      <div className="doc-tl-head">
        <span className="doc-tl-title">Timeline</span>
        <span className="doc-tl-meta">
          {total.toFixed(2)}s · {composition.width}×{composition.height} · {composition.fps}fps ·
          rev {composition.rev}
        </span>
        {hasClips ? (
          <input
            type="range"
            className="doc-tl-scrub"
            min={0}
            max={spanSec}
            step={0.01}
            value={playhead}
            onChange={(e) => onScrub(Number(e.target.value))}
            aria-label="Playhead position (seconds)"
          />
        ) : null}
        <span className="doc-tl-playtime">▶ {playhead.toFixed(2)}s</span>
        <button
          type="button"
          className="btn-secondary doc-tl-histbtn"
          onClick={onUndo}
          disabled={!history.canUndo}
          title="Undo timeline edit"
        >
          ↶
        </button>
        <button
          type="button"
          className="btn-secondary doc-tl-histbtn"
          onClick={onRedo}
          disabled={!history.canRedo}
          title="Redo timeline edit"
        >
          ↷
        </button>
        <button
          type="button"
          className="btn-primary doc-tl-export"
          onClick={onExport}
          disabled={exporting || !hasClips}
        >
          {exporting ? 'Exporting…' : 'Export ▸'}
        </button>
      </div>

      {hasClips ? (
        <div className="doc-tl-scroll">
          <div className="doc-tl-inner" style={{ width: GUTTER + laneWidth }}>
            <div className="doc-tl-ruler-row">
              <div className="doc-tl-gutter" />
              <div className="doc-tl-ruler" style={{ width: laneWidth }}>
                {ticks.map((t) => (
                  <div className="doc-tl-tick" key={t} style={{ left: t * PX_PER_SEC }}>
                    <span className="doc-tl-tick-label">{t}s</span>
                  </div>
                ))}
              </div>
            </div>

            {composition.tracks.map((track) => (
              <div className="doc-tl-lane" key={track.id}>
                <div className="doc-tl-lane-label">
                  <span className="doc-tl-track-id">{track.id}</span>
                  <span className="doc-tl-track-kind">{track.kind}</span>
                </div>
                <div className="doc-tl-clips" style={{ width: laneWidth }}>
                  {track.clips.map((clip) => (
                    <ClipBlock
                      key={clip.id}
                      clip={clip}
                      selected={clip.id === selectedClipId}
                      onSelect={onSelectClip}
                    />
                  ))}
                  {track.transitions.map((tr) => {
                    const after = track.clips.find((c) => c.id === tr.afterClipId);
                    if (!after) return null;
                    return (
                      <div
                        key={tr.afterClipId}
                        className="doc-tl-transition"
                        style={{ left: clipEndSec(after) * PX_PER_SEC }}
                        title={`${tr.kind} · ${tr.durationSec}s`}
                      >
                        <span className="doc-tl-transition-label">{tr.kind}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <div
              className="doc-tl-playhead"
              style={{ left: GUTTER + playhead * PX_PER_SEC }}
              aria-hidden="true"
            />
          </div>
        </div>
      ) : (
        <div className="doc-tl-empty">
          No clips yet — drop in media or add a clip to start building the timeline.
        </div>
      )}
    </section>
  );
}

function ClipBlock({
  clip,
  selected,
  onSelect,
}: {
  clip: Clip;
  selected: boolean;
  onSelect: (clipId: string | null) => void;
}) {
  const left = clip.startSec * PX_PER_SEC;
  const width = clipDuration(clip) * PX_PER_SEC;
  return (
    <button
      type="button"
      className={`doc-tl-clip doc-tl-clip-${clip.kind}${selected ? ' selected' : ''}`}
      style={{ left, width }}
      onClick={() => onSelect(selected ? null : clip.id)}
      title={`${clipLabel(clip)} · ${clip.startSec.toFixed(2)}–${clipEndSec(clip).toFixed(2)}s`}
    >
      {clip.kind === 'media' ? <Filmstrip clip={clip} width={width} /> : null}
      <span className="doc-tl-clip-label">{clipLabel(clip)}</span>
      <span className="doc-tl-clip-dur">{clipDuration(clip).toFixed(1)}s</span>
    </button>
  );
}

/**
 * A filmstrip: a row of source-frame thumbnails across the clip's trimmed window.
 * Each frame is a cached `/api/media/thumb` still sampled at the middle of its
 * slot; the clip's gradient shows underneath until they load.
 */
function Filmstrip({ clip, width }: { clip: MediaClip; width: number }) {
  const n = Math.max(1, Math.min(MAX_THUMBS, Math.round(width / TARGET_THUMB_W)));
  const { mediaId, sourceInSec, sourceOutSec } = clip;
  const slotW = width / n;
  return (
    <span className="doc-tl-filmstrip" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        const t = sourceInSec + ((i + 0.5) / n) * (sourceOutSec - sourceInSec);
        return (
          <img
            key={t}
            className="doc-tl-thumb"
            style={{ width: slotW }}
            src={`/api/media/thumb?mediaId=${encodeURIComponent(mediaId)}&t=${t.toFixed(2)}&h=${THUMB_H}`}
            alt=""
            loading="lazy"
            draggable={false}
          />
        );
      })}
      <span className="doc-tl-clip-scrim" />
    </span>
  );
}
