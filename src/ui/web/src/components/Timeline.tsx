import { type DragEvent, useMemo, useState } from 'react';
import { useRunTool } from '../hooks/useRunTool.js';
import { allPlayableClips, clipKey, type PlayableClip } from '../lib/playable-clips.js';
import type { Session } from '../types.js';
import { CLIP_DRAG_TYPE, TimelineCard } from './TimelineCard.js';

interface ConcatResult {
  path: string;
  inputCount: number;
}

interface DragPayload {
  key: string;
  source: 'outputs' | 'queue';
}

/**
 * Two horizontal tracks below the import zone:
 *   - Outputs: every playable video clip the session has produced or ingested
 *   - Queue:   staged ordering for the next concat; built by dragging from Outputs
 *
 * The Queue stores clip keys (opId or opId#subId), not full objects, so it
 * stays valid across session refreshes — a card the user dragged in still
 * resolves to the same backing entry the next render.
 */
export function Timeline({
  session,
  selectedOpId,
  onSelect,
  onConcatSuccess,
}: {
  session: Session;
  /** Currently-played opId in the DetailPane — for highlighting matching cards. */
  selectedOpId: string | null;
  /** Click a card → preview that op in the DetailPane. */
  onSelect: (opId: string) => void;
  /** Called after a successful concat from the queue (so App can refresh session). */
  onConcatSuccess?: () => void | Promise<void>;
}) {
  const outputs = useMemo(() => allPlayableClips(session.entries), [session.entries]);
  const clipByKey = useMemo(() => {
    const map = new Map<string, PlayableClip>();
    for (const c of outputs) map.set(clipKey(c), c);
    return map;
  }, [outputs]);

  // Queue is local; only clip keys survive across session refreshes.
  const [queueKeys, setQueueKeys] = useState<string[]>([]);
  const { run, loading, error } = useRunTool<ConcatResult>('concat');

  // Drop a card from Outputs (append) or reorder within Queue. `targetIndex`
  // is the index the dragged item should land at; passing `queueKeys.length`
  // means "append at end".
  function handleDrop(e: DragEvent<HTMLElement>, targetIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData(CLIP_DRAG_TYPE);
    if (!raw) return;
    let payload: DragPayload;
    try {
      payload = JSON.parse(raw) as DragPayload;
    } catch {
      return;
    }
    if (payload.source === 'outputs') {
      // Add: skip duplicates so a clip isn't queued twice by accident.
      setQueueKeys((prev) => {
        if (prev.includes(payload.key)) return prev;
        const next = [...prev];
        next.splice(targetIndex, 0, payload.key);
        return next;
      });
    } else {
      // Reorder within queue.
      setQueueKeys((prev) => {
        const from = prev.indexOf(payload.key);
        if (from === -1) return prev;
        const next = prev.filter((k) => k !== payload.key);
        // After removal, indices >from shift left by one; adjust target.
        const adjusted = from < targetIndex ? targetIndex - 1 : targetIndex;
        next.splice(adjusted, 0, payload.key);
        return next;
      });
    }
  }

  function allowDrop(e: DragEvent<HTMLElement>) {
    if (e.dataTransfer.types.includes(CLIP_DRAG_TYPE)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function removeFromQueue(key: string) {
    setQueueKeys((prev) => prev.filter((k) => k !== key));
  }

  async function handleConcat() {
    const paths = queueKeys
      .map((k) => clipByKey.get(k)?.path)
      .filter((p): p is string => typeof p === 'string');
    if (paths.length < 2) return;
    const result = await run({ inputs: paths });
    if (result) {
      setQueueKeys([]);
      await onConcatSuccess?.();
    }
  }

  // Resolve queue keys to clips for rendering. A key with no backing clip
  // (e.g. its op was deleted) gets filtered out so the queue self-heals.
  const queueClips = queueKeys
    .map((k) => ({ key: k, clip: clipByKey.get(k) }))
    .filter((q): q is { key: string; clip: PlayableClip } => q.clip !== undefined);

  return (
    <section className="timeline" aria-label="Visual timeline">
      <TimelineTrack
        label="Outputs"
        emptyHint="Import or run a tool to see clips here."
        clips={outputs}
        selectedOpId={selectedOpId}
        source="outputs"
        onCardClick={onSelect}
      />
      <TimelineQueue
        clips={queueClips}
        selectedOpId={selectedOpId}
        onCardClick={onSelect}
        onRemove={removeFromQueue}
        onDrop={handleDrop}
        onDragOver={allowDrop}
        onConcat={handleConcat}
        loading={loading}
        error={error?.message ?? null}
      />
    </section>
  );
}

function TimelineTrack({
  label,
  emptyHint,
  clips,
  selectedOpId,
  source,
  onCardClick,
}: {
  label: string;
  emptyHint: string;
  clips: PlayableClip[];
  selectedOpId: string | null;
  source: 'outputs' | 'queue';
  onCardClick: (opId: string) => void;
}) {
  return (
    <div className="timeline-track">
      <div className="timeline-track-label">{label}</div>
      <div className="timeline-track-strip">
        {clips.length === 0 ? (
          <div className="timeline-empty">{emptyHint}</div>
        ) : (
          clips.map((clip) => (
            <TimelineCard
              key={clipKey(clip)}
              clip={clip}
              selected={clip.opId === selectedOpId}
              source={source}
              onClick={() => onCardClick(clip.opId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TimelineQueue({
  clips,
  selectedOpId,
  onCardClick,
  onRemove,
  onDrop,
  onDragOver,
  onConcat,
  loading,
  error,
}: {
  clips: Array<{ key: string; clip: PlayableClip }>;
  selectedOpId: string | null;
  onCardClick: (opId: string) => void;
  onRemove: (key: string) => void;
  onDrop: (e: DragEvent<HTMLElement>, targetIndex: number) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onConcat: () => Promise<void> | void;
  loading: boolean;
  error: string | null;
}) {
  const canConcat = clips.length >= 2 && !loading;

  return (
    <div className="timeline-track timeline-track-queue">
      <div className="timeline-track-label">
        Render queue
        <span className="timeline-track-sub"> · drag from above</span>
      </div>
      {/* The strip is a generic drop region — using <section> so the
          a11y rules accept the interactive handlers without ignores. */}
      <section
        className="timeline-track-strip timeline-track-droptarget"
        aria-label="Render queue drop zone"
        onDragOver={onDragOver}
        onDrop={(e) => onDrop(e, clips.length)}
      >
        {clips.length === 0 ? (
          <div className="timeline-empty">Drop clips here to stage a concat.</div>
        ) : (
          clips.map(({ key, clip }, i) => (
            // Each queue slot is also a drop target so the user can insert
            // a reordered card at this exact position rather than always
            // appending at the end of the strip.
            // biome-ignore lint/a11y/noStaticElementInteractions: per-card drop slot, same reason as the strip
            <div
              key={key}
              className="timeline-card-wrap"
              onDragOver={onDragOver}
              onDrop={(e) => {
                e.stopPropagation();
                onDrop(e, i);
              }}
            >
              <TimelineCard
                clip={clip}
                selected={clip.opId === selectedOpId}
                source="queue"
                onClick={() => onCardClick(clip.opId)}
              />
              <button
                type="button"
                className="timeline-card-remove"
                aria-label="Remove from queue"
                title="Remove"
                onClick={() => onRemove(key)}
              >
                ×
              </button>
            </div>
          ))
        )}
      </section>
      <div className="timeline-queue-actions">
        {error ? <span className="timeline-queue-error">{error}</span> : null}
        <button
          type="button"
          className="btn-primary"
          onClick={() => void onConcat()}
          disabled={!canConcat}
          title={clips.length < 2 ? 'Drop at least two clips into the queue first.' : 'Run concat'}
        >
          {loading ? 'Concatting…' : `Concat ▶ ${clips.length || ''}`}
        </button>
      </div>
    </div>
  );
}
