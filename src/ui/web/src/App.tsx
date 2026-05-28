import { useState } from 'react';
import { DetailPane } from './components/DetailPane.js';
import { AddTextForm } from './components/forms/AddTextForm.js';
import { AddTitleCardForm } from './components/forms/AddTitleCardForm.js';
import { ConcatForm } from './components/forms/ConcatForm.js';
import { RenderForm } from './components/forms/RenderForm.js';
import { SplitForm } from './components/forms/SplitForm.js';
import { TransitionForm } from './components/forms/TransitionForm.js';
import { TrimForm } from './components/forms/TrimForm.js';
import { Header } from './components/Header.js';
import { ImportZone } from './components/ImportZone.js';
import { OpList } from './components/OpList.js';
import { ToolPickerModal } from './components/ToolPickerModal.js';
import { useSession } from './hooks/useSession.js';

export function App() {
  const { session, loading, error, refresh } = useSession();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);

  const selectedEntry =
    selectedId === null ? null : (session.entries.find((e) => e.id === selectedId) ?? null);

  function handlePickTool(name: string) {
    setActiveTool(name);
    setPickerOpen(false);
    setSelectedId(null); // form takes over the right pane
  }

  async function handleFormSuccess(): Promise<void> {
    setActiveTool(null);
    await refresh();
  }

  function handleFormCancel() {
    setActiveTool(null);
  }

  async function handleImported(): Promise<void> {
    await refresh();
  }

  return (
    <div className="app">
      <Header totalOps={session.entries.length} onNewOp={() => setPickerOpen(true)} />
      <ImportZone onImported={handleImported} />
      <main className="main">
        <OpList
          entries={session.entries}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setActiveTool(null); // selecting an op replaces the active form
          }}
        />
        {error ? (
          <section className="detail">
            <div className="placeholder">Could not load session: {error}</div>
          </section>
        ) : loading ? (
          <section className="detail">
            <div className="placeholder">Loading…</div>
          </section>
        ) : activeTool ? (
          <section className="detail">
            <ActiveForm
              name={activeTool}
              session={session}
              onSuccess={handleFormSuccess}
              onCancel={handleFormCancel}
            />
          </section>
        ) : (
          <DetailPane entry={selectedEntry} />
        )}
      </main>
      <ToolPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickTool}
      />
    </div>
  );
}

/**
 * Dispatch by tool name. Each form takes the same `(session, onSuccess,
 * onCancel)` shape — adding a new form means one new import + one new case.
 */
function ActiveForm({
  name,
  session,
  onSuccess,
  onCancel,
}: {
  name: string;
  session: ReturnType<typeof useSession>['session'];
  onSuccess: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const handleSuccess = () => {
    void onSuccess();
  };
  switch (name) {
    case 'trim':
      return <TrimForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'split':
      return <SplitForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'concat':
      return <ConcatForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'add_text':
      return <AddTextForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'add_title_card':
      return <AddTitleCardForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'transition':
      return <TransitionForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'render':
      return <RenderForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    default:
      return <div className="placeholder">No form for "{name}".</div>;
  }
}
