import { MAIN_TIMELINE, shapeLabel, type TimelineListing } from '../lib/timelines.js';

/** What the last short-making or export-all did, shown under the tabs. */
export interface TimelineNotice {
  kind: 'info' | 'warn';
  lines: string[];
}

/**
 * One tab per timeline in the workspace, main and every short, each with its
 * shape. A short's ✕ deletes it (the caller confirms), and "Export all shorts"
 * renders each one. Shown once there is a short.
 */
export function TimelineTabs({
  timelines,
  current,
  exportingAll,
  notice,
  onSelect,
  onDelete,
  onExportAll,
  onDismissNotice,
}: {
  timelines: TimelineListing[];
  current: string;
  exportingAll: boolean;
  notice: TimelineNotice | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onExportAll: () => void;
  onDismissNotice: () => void;
}) {
  const shorts = timelines.filter((t) => t.id !== MAIN_TIMELINE);
  if (shorts.length === 0 && notice === null) return null;

  return (
    <div className="tl-tabs-bar">
      <div className="tl-tabs">
        <div className="tl-tabs-list" role="tablist" aria-label="Timelines">
          {timelines.map((t) => {
            const isCurrent = t.id === current;
            const shape = 'error' in t ? 'unreadable' : shapeLabel(t.width, t.height);
            return (
              <div key={t.id} className={`tl-tab${isCurrent ? ' is-current' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isCurrent}
                  aria-label={`${t.id}, ${shape}`}
                  className="tl-tab-select"
                  title={
                    'error' in t ? t.error : `${t.durationSec.toFixed(1)}s · ${t.width}×${t.height}`
                  }
                  onClick={() => onSelect(t.id)}
                >
                  {t.id}
                  <span className="tl-tab-shape">{shape}</span>
                </button>
                {t.id === MAIN_TIMELINE ? null : (
                  <button
                    type="button"
                    className="tl-tab-delete"
                    aria-label={`Delete ${t.id}`}
                    title="Delete this short"
                    onClick={() => onDelete(t.id)}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="btn-secondary tl-export-all"
          disabled={shorts.length === 0 || exportingAll}
          onClick={onExportAll}
        >
          {exportingAll
            ? `Exporting ${shorts.length} short${shorts.length === 1 ? '' : 's'}…`
            : `Export all shorts (${shorts.length})`}
        </button>
      </div>
      {notice ? (
        <div className={`tl-notice${notice.kind === 'warn' ? ' is-warn' : ''}`} role="status">
          <div className="tl-notice-lines">
            {notice.lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
          <button
            type="button"
            className="tl-tab-delete"
            aria-label="Dismiss"
            onClick={onDismissNotice}
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}
