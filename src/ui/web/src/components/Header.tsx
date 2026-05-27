import { useEffect, useState } from 'react';

export function Header({ totalOps }: { totalOps: number }) {
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
      <div className="meta">
        {totalOps} op{totalOps === 1 ? '' : 's'} · {workspace || '...'}
      </div>
    </header>
  );
}
