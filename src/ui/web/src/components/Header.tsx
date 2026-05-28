import { useEffect, useState } from 'react';

export function Header({
  totalOps,
  onNewOp,
  onUndo,
  onSnapshot,
  snapshots,
  onRestore,
  safetyLoading,
  chatOpen,
  onToggleChat,
}: {
  totalOps: number;
  onNewOp: () => void;
  onUndo: () => void;
  onSnapshot: () => void;
  snapshots: string[];
  onRestore: (label: string) => void;
  safetyLoading: boolean;
  chatOpen: boolean;
  onToggleChat: () => void;
}) {
  const [workspace, setWorkspace] = useState<string>('');
  const [snapsOpen, setSnapsOpen] = useState(false);

  useEffect(() => {
    fetch('/api/workspace')
      .then((r) => r.json() as Promise<{ path: string }>)
      .then((r) => setWorkspace(r.path))
      .catch(() => undefined);
  }, []);

  return (
    <header className="header">
      <h1>MakeMyClip Editor</h1>
      <div className="header-right">
        <span className="meta">
          {totalOps} op{totalOps === 1 ? '' : 's'} · {workspace || '...'}
        </span>
        <button
          type="button"
          className="btn-secondary header-btn-secondary"
          onClick={onUndo}
          disabled={safetyLoading || totalOps === 0}
          title="Undo last op (⌘Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className="btn-secondary header-btn-secondary"
          onClick={onSnapshot}
          disabled={safetyLoading || totalOps === 0}
          title="Save snapshot (⌘S)"
        >
          Snapshot
        </button>
        {snapshots.length > 0 ? (
          <div className="snapshots-dropdown">
            <button
              type="button"
              className="btn-secondary header-btn-secondary"
              onClick={() => setSnapsOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={snapsOpen}
              title="Restore from snapshot"
            >
              ⤺ {snapshots.length}
            </button>
            {snapsOpen ? (
              // Lightweight menu — clicking anywhere outside closes via the
              // click-on-item handler; an outside-click hook would be tidier
              // but isn't worth the complexity for a 1-deep dropdown.
              <div className="snapshots-menu" role="menu" onMouseLeave={() => setSnapsOpen(false)}>
                {snapshots.map((label) => (
                  <button
                    key={label}
                    type="button"
                    className="snapshot-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setSnapsOpen(false);
                      onRestore(label);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className={`btn-secondary header-btn-secondary${chatOpen ? ' active' : ''}`}
          onClick={onToggleChat}
          title="Toggle chat with the agent"
          aria-pressed={chatOpen}
        >
          💬 Chat
        </button>
        <button type="button" className="btn-primary header-btn" onClick={onNewOp}>
          + New op
        </button>
      </div>
    </header>
  );
}
