import { useState } from 'react';
import { ChatPanel } from './components/ChatPanel.js';
import { DetailPane } from './components/DetailPane.js';
import { AddCaptionsForm } from './components/forms/AddCaptionsForm.js';
import { AddTextForm } from './components/forms/AddTextForm.js';
import { AddTitleCardForm } from './components/forms/AddTitleCardForm.js';
import { ChromaKeyForm } from './components/forms/ChromaKeyForm.js';
import { ConcatForm } from './components/forms/ConcatForm.js';
import { HighlightReelForm } from './components/forms/HighlightReelForm.js';
import { RenderForm } from './components/forms/RenderForm.js';
import { SilenceRemoveForm } from './components/forms/SilenceRemoveForm.js';
import { SplitForm } from './components/forms/SplitForm.js';
import { TransitionForm } from './components/forms/TransitionForm.js';
import { TrimForm } from './components/forms/TrimForm.js';
import { Header } from './components/Header.js';
import { ImportZone } from './components/ImportZone.js';
import { OpList } from './components/OpList.js';
import { Timeline } from './components/Timeline.js';
import { ToolPickerModal } from './components/ToolPickerModal.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSession } from './hooks/useSession.js';
import { useSessionSafety } from './hooks/useSessionSafety.js';

export function App() {
  const { session, loading, error, refresh } = useSession();
  const safety = useSessionSafety();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  const selectedEntry =
    selectedId === null ? null : (session.entries.find((e) => e.id === selectedId) ?? null);

  function handlePickTool(name: string) {
    setActiveTool(name);
    setPickerOpen(false);
    setSelectedId(null);
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

  async function handleUndo() {
    setSafetyError(null);
    const result = await safety.popOrRestore();
    if (!result && safety.error) {
      setSafetyError(safety.error);
      return;
    }
    setActiveTool(null);
    await refresh();
  }

  async function handleSnapshot() {
    setSafetyError(null);
    const label = window.prompt(
      'Snapshot label (letters, digits, _, -). Leave blank for the default snap-<N>.',
    );
    // null = user hit cancel; "" = user hit OK with empty input → default name
    if (label === null) return;
    const result = await safety.takeSnapshot(label || undefined);
    if (!result && safety.error) setSafetyError(safety.error);
  }

  async function handleRestore(label: string) {
    if (
      !window.confirm(
        `Restore snapshot "${label}"? The current session log will be replaced (output files are not deleted).`,
      )
    ) {
      return;
    }
    setSafetyError(null);
    const result = await safety.popOrRestore(label);
    if (!result && safety.error) {
      setSafetyError(safety.error);
      return;
    }
    setActiveTool(null);
    setSelectedId(null);
    await refresh();
  }

  // The hook reads the latest handler refs internally, so passing fresh
  // closures here doesn't thrash the window event listener.
  useKeyboardShortcuts({
    onUndo: () => void handleUndo(),
    onSnapshot: () => void handleSnapshot(),
    onNewOp: () => setPickerOpen(true),
    onEscape: () => {
      if (pickerOpen) setPickerOpen(false);
      else if (activeTool) setActiveTool(null);
    },
  });

  return (
    <div className="app">
      <Header
        totalOps={session.entries.length}
        onNewOp={() => setPickerOpen(true)}
        onUndo={() => void handleUndo()}
        onSnapshot={() => void handleSnapshot()}
        snapshots={safety.snapshots}
        onRestore={(label) => void handleRestore(label)}
        safetyLoading={safety.loading}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
      />
      {safetyError ? <div className="safety-error-bar">{safetyError}</div> : null}
      <ImportZone onImported={handleImported} />
      <Timeline
        session={session}
        selectedOpId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setActiveTool(null);
        }}
        onConcatSuccess={refresh}
      />
      <main className={`main${chatOpen ? ' main-with-chat' : ''}`}>
        <OpList
          entries={session.entries}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setActiveTool(null);
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
        {chatOpen ? (
          <ChatPanel onAgentTurnComplete={refresh} onClose={() => setChatOpen(false)} />
        ) : null}
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
    case 'add_captions':
      return <AddCaptionsForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'transition':
      return <TransitionForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'render':
      return <RenderForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'highlight_reel':
      return <HighlightReelForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'silence_remove':
      return <SilenceRemoveForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    case 'chroma_key':
      return <ChromaKeyForm session={session} onSuccess={handleSuccess} onCancel={onCancel} />;
    default:
      return <div className="placeholder">No form for "{name}".</div>;
  }
}
