import type { DragEvent } from 'react';
import { clipKey, type PlayableClip } from '../lib/playable-clips.js';

/**
 * Custom drag mimetype so timeline drags don't collide with the
 * ImportZone's file-drop handler (which checks dataTransfer.files).
 */
export const CLIP_DRAG_TYPE = 'application/x-makemyclip-clip';

/**
 * A single draggable clip thumbnail. Pure button — the queue's X-to-remove
 * affordance lives in the parent as a sibling button so we don't nest
 * interactive elements (and keep this a11y-clean as a real `<button>`).
 */
export function TimelineCard({
  clip,
  selected,
  onClick,
  source,
}: {
  clip: PlayableClip;
  selected: boolean;
  onClick: () => void;
  /**
   * Where the drag should be interpreted: 'outputs' means "add to queue",
   * 'queue' means "reorder within queue". Embedded in the drag payload.
   */
  source: 'outputs' | 'queue';
}) {
  const key = clipKey(clip);

  function onDragStart(e: DragEvent<HTMLButtonElement>) {
    // Encode source + key so the drop handler knows whether this is an
    // add (from outputs) or a reorder (from queue).
    e.dataTransfer.setData(CLIP_DRAG_TYPE, JSON.stringify({ key, source }));
    e.dataTransfer.effectAllowed = source === 'queue' ? 'move' : 'copy';
  }

  return (
    <button
      type="button"
      className={`timeline-card${selected ? ' timeline-card-selected' : ''}`}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      aria-label={`${clip.tool}: ${clip.label}`}
    >
      <img
        src={`/api/preview/${clip.opId}?atSec=0`}
        alt=""
        className="timeline-card-thumb"
        draggable={false}
      />
      <div className="timeline-card-label" title={clip.label}>
        {clip.label}
      </div>
      <div className="timeline-card-tool">{clip.tool}</div>
    </button>
  );
}
