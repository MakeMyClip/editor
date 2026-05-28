import { type DragEvent, useState } from 'react';
import { useDuration } from '../hooks/useDuration.js';
import { clipKey, type PlayableClip } from '../lib/playable-clips.js';

/**
 * Custom drag mimetype so timeline drags don't collide with the
 * ImportZone's file-drop handler (which checks dataTransfer.files).
 */
export const CLIP_DRAG_TYPE = 'application/x-makemyclip-clip';

/**
 * A single draggable clip thumbnail with optional scrub slider. The queue's
 * X-to-remove affordance lives in the parent as a sibling button (avoids
 * nesting interactive elements).
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
  // Duration drives the scrub slider's range. null = still loading or not
  // probe-able; we just don't render the slider in that case.
  const duration = useDuration(clip.opId);
  // Slider value (seconds). Drives the thumb's atSec query.
  const [atSec, setAtSec] = useState(0);

  function onDragStart(e: DragEvent<HTMLButtonElement>) {
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
        src={`/api/preview/${clip.opId}?atSec=${atSec}`}
        alt=""
        className="timeline-card-thumb"
        draggable={false}
      />
      <div className="timeline-card-label" title={clip.label}>
        {clip.label}
      </div>
      <div className="timeline-card-tool">{clip.tool}</div>
      {duration !== null && duration > 0.1 ? (
        // Slider inside a button: stopPropagation prevents the slider's
        // mousedown from triggering the card's drag, and clicking the
        // slider's track is harmless (just sets a value, no submit).
        <input
          type="range"
          className="timeline-card-scrub"
          min={0}
          max={duration}
          step={Math.max(0.1, duration / 100)}
          value={atSec}
          aria-label={`Scrub to a moment in ${clip.label}`}
          onChange={(e) => setAtSec(Number(e.target.value))}
          // Prevent the slider drag from initiating an HTML5 card drag —
          // they fight over the same gesture otherwise.
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : null}
    </button>
  );
}
