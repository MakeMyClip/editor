import { useEffect, useState } from 'react';

export function Header({ totalOps, onNewOp }: { totalOps: number; onNewOp: () => void }) {
  const [workspace, setWorkspace] = useState<string>('');

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
        <button type="button" className="btn-primary header-btn" onClick={onNewOp}>
          + New op
        </button>
      </div>
    </header>
  );
}
