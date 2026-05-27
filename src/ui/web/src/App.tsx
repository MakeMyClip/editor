import { useState } from 'react';
import { DetailPane } from './components/DetailPane.js';
import { Header } from './components/Header.js';
import { OpList } from './components/OpList.js';
import { useSession } from './hooks/useSession.js';

export function App() {
  const { session, loading, error } = useSession();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedEntry =
    selectedId === null ? null : (session.entries.find((e) => e.id === selectedId) ?? null);

  return (
    <div className="app">
      <Header totalOps={session.entries.length} />
      <main className="main">
        <OpList entries={session.entries} selectedId={selectedId} onSelect={setSelectedId} />
        {error ? (
          <section className="detail">
            <div className="placeholder">Could not load session: {error}</div>
          </section>
        ) : loading ? (
          <section className="detail">
            <div className="placeholder">Loading…</div>
          </section>
        ) : (
          <DetailPane entry={selectedEntry} />
        )}
      </main>
    </div>
  );
}
