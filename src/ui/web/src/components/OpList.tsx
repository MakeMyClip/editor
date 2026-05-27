import type { SessionEntry } from '../types.js';

function summarize(entry: SessionEntry): string {
  // Mirrors src/tools/inspect.ts#summarizeEntry — duplicated here because
  // the UI bundle doesn't pull from the editor package directly.
  const a = entry.args;
  const input = typeof a.input === 'string' ? a.input : '';
  switch (entry.tool) {
    case 'ingest':
      return `${a.path ?? input}`;
    case 'trim':
      return `${input} ${a.start ?? ''}→${a.end ?? ''}`;
    case 'split':
      return `${input} at ${a.atSec ?? ''}s`;
    case 'concat':
      return `${Array.isArray(a.inputs) ? a.inputs.length : 0} clips`;
    case 'add_text':
      return `"${String(a.text ?? '').slice(0, 30)}" ${a.startSec ?? ''}→${a.endSec ?? ''}s`;
    case 'add_audio':
      return `${a.mode ?? 'mix'} ${a.audio ?? ''}`;
    case 'transition':
      return `${a.kind ?? 'fade'} between A and B`;
    case 'render':
      return `${input} → ${a.format ?? 'mp4'}`;
    case 'preview':
      return `${input} @ ${a.atSec ?? ''}s`;
    case 'transform':
      return `${a.op ?? ''} ${input}`;
    case 'adjust':
      return Object.keys(a)
        .filter((k) => k !== 'input')
        .join('+');
    case 'speed':
      return `${input} ×${a.factor ?? 1}${a.reverse ? ' reversed' : ''}`;
    case 'overlay':
      return `${a.overlay ?? ''} @ ${a.position ?? 'top-right'}`;
    case 'zoom_pan':
      return `${a.fromZoom ?? 1}→${a.toZoom ?? 1.5}`;
    case 'add_title_card':
      return `"${String(a.text ?? '').slice(0, 30)}" ${a.durationSec ?? 2}s`;
    case 'add_captions':
      return `${Array.isArray(a.cues) ? a.cues.length : 0} cues`;
    case 'silence_remove':
      return `${input} (-${Math.abs(Number(a.noiseDb ?? 30))}dB)`;
    case 'highlight_reel':
      return `${Array.isArray(a.segments) ? a.segments.length : 0} segments`;
    case 'chroma_key':
      return `${a.color ?? 'green'} on ${a.background ?? ''}`;
    case 'stabilize':
      return `${input} shakiness ${a.shakiness ?? 5}`;
    default:
      return input;
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

export function OpList({
  entries,
  selectedId,
  onSelect,
}: {
  entries: SessionEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <aside className="op-list">
        <div className="empty">
          No operations yet. Run a tool from the CLI or skill to populate this list.
        </div>
      </aside>
    );
  }

  return (
    <aside className="op-list">
      {entries
        .slice()
        .reverse()
        .map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={`op ${entry.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(entry.id)}
          >
            <div className="tool">{entry.tool}</div>
            <div className="summary">{summarize(entry)}</div>
            <div className="timestamp">{relativeTime(entry.timestamp)}</div>
          </button>
        ))}
    </aside>
  );
}
