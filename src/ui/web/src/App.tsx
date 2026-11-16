import { useEffect, useMemo, useState } from 'react';
import { ClipInspector } from './components/ClipInspector.js';
import { DetailPane } from './components/DetailPane.js';
import { DocTimeline } from './components/DocTimeline.js';
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
import { type TimelineNotice, TimelineTabs } from './components/TimelineTabs.js';
import { ToolPickerModal } from './components/ToolPickerModal.js';
import { Viewer } from './components/Viewer.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSession } from './hooks/useSession.js';
import { useSessionSafety } from './hooks/useSessionSafety.js';
import { useTimeline } from './hooks/useTimeline.js';
import { useTimelines } from './hooks/useTimelines.js';
import { findClip, mediaNames, nextClipOnTrack } from './lib/composition.js';
import { MAIN_TIMELINE, nextShortId, withTimeline } from './lib/timelines.js';
import { applyTimelineVerbs, type Verb } from './lib/verbs.js';

/** A short `POST /api/timelines/export` rendered, or why it couldn't. */
type ExportedShort =
  | { timeline: string; output: string; loudness?: { outputLufs: number | null } }
  | { timeline: string; error: string };

export function App() {
  const { session, loading, error, refresh } = useSession();
  const {
    timelines,
    current: timeline,
    select: selectTimeline,
    refresh: refreshTimelines,
  } = useTimelines();
  const { composition, missing, refresh: refreshTimeline } = useTimeline(timeline);
  const safety = useSessionSafety();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  const [verbBusy, setVerbBusy] = useState(false);
  const [verbError, setVerbError] = useState<string | null>(null);
  const [exportingAll, setExportingAll] = useState(false);
  const [notice, setNotice] = useState<TimelineNotice | null>(null);

  const selectedEntry =
    selectedId === null ? null : (session.entries.find((e) => e.id === selectedId) ?? null);
  const selected = selectedClipId === null ? null : findClip(composition, selectedClipId);
  const names = useMemo(() => mediaNames(session.entries), [session.entries]);
  const freeShortId = nextShortId(timelines.map((t) => t.id));

  // Each timeline has its own clips and length, so switching starts clean.
  function openTimeline(id: string) {
    selectTimeline(id);
    setSelectedClipId(null);
    setPlayheadSec(0);
    setVerbError(null);
  }

  // A short deleted elsewhere (the agent, another tab) falls back to main.
  useEffect(() => {
    if (missing && timeline !== MAIN_TIMELINE) {
      selectTimeline(MAIN_TIMELINE);
      setSelectedClipId(null);
      setPlayheadSec(0);
    }
  }, [missing, timeline, selectTimeline]);

  // Selecting an op and selecting a doc-clip are mutually exclusive — each owns
  // the inspector pane, so picking one clears the other.
  function selectOp(id: string) {
    setSelectedId(id);
    setSelectedClipId(null);
    setActiveTool(null);
  }
  function selectClip(clipId: string | null) {
    setSelectedClipId(clipId);
    setSelectedId(null);
    setActiveTool(null);
    setVerbError(null);
  }

  /** Resolves to the number of ops applied, or null if the edit failed. */
  async function handleApplyVerbs(verbs: Verb[]): Promise<number | null> {
    setVerbBusy(true);
    setVerbError(null);
    try {
      const { applied } = await applyTimelineVerbs(verbs, timeline);
      await Promise.all([refreshTimeline(), refresh()]);
      return applied;
    } catch (err) {
      setVerbError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setVerbBusy(false);
    }
  }

  /** Make a short on timeline `id` and open it; false when it couldn't be made. */
  async function handleMakeShort(id: string, verb: Verb): Promise<boolean> {
    setVerbBusy(true);
    setVerbError(null);
    try {
      const { warnings } = await applyTimelineVerbs([verb], id);
      await Promise.all([refreshTimelines(), refresh()]);
      openTimeline(id);
      setNotice({
        kind: warnings.length > 0 ? 'warn' : 'info',
        lines: [`Made ${id}.`, ...warnings],
      });
      return true;
    } catch (err) {
      setVerbError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setVerbBusy(false);
    }
  }

  async function handleDeleteTimeline(id: string): Promise<void> {
    if (
      !window.confirm(
        `Delete the short "${id}"? Its edits and undo history go with it; files you exported stay.`,
      )
    ) {
      return;
    }
    setSafetyError(null);
    try {
      const res = await fetch(`/api/timelines/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      await refreshTimelines();
      if (id === timeline) openTimeline(MAIN_TIMELINE);
    } catch (err) {
      setSafetyError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleExportAll(): Promise<void> {
    setExportingAll(true);
    setSafetyError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/timelines/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const json = (await res.json()) as {
        dir?: string;
        exported?: ExportedShort[];
        error?: string;
      };
      if (!res.ok || !json.exported) throw new Error(json.error ?? `HTTP ${res.status}`);
      await refresh(); // each short now shows in Outputs
      const saved = json.exported.flatMap((e) =>
        'error' in e
          ? []
          : [
              e.loudness?.outputLufs != null
                ? `${e.timeline} (${e.loudness.outputLufs.toFixed(1)} LUFS)`
                : e.timeline,
            ],
      );
      const failed = json.exported.flatMap((e) =>
        'error' in e ? [`${e.timeline} didn't render: ${e.error}`] : [],
      );
      setNotice({
        kind: failed.length > 0 ? 'warn' : 'info',
        lines: [
          ...(saved.length > 0
            ? [`Saved ${saved.length} in ${json.dir ?? 'the workspace'}: ${saved.join(', ')}.`]
            : []),
          ...failed,
        ],
      });
    } catch (err) {
      setSafetyError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportingAll(false);
    }
  }

  async function handleTimelineHistory(direction: 'undo' | 'redo'): Promise<void> {
    setVerbError(null);
    try {
      const res = await fetch(withTimeline(`/api/timeline/${direction}`, timeline), {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await Promise.all([refreshTimeline(), refresh()]);
    } catch (err) {
      setSafetyError(
        `Timeline ${direction} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleExport(): Promise<void> {
    setVerbBusy(true);
    setSafetyError(null);
    try {
      const res = await fetch(withTimeline('/api/timeline/export', timeline), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const json = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !json.id) throw new Error(json.error ?? `HTTP ${res.status}`);
      await refresh(); // the export op now shows in Outputs
      selectOp(json.id); // and plays in the inspector
    } catch (err) {
      setSafetyError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVerbBusy(false);
    }
  }

  function handlePickTool(name: string) {
    setActiveTool(name);
    setPickerOpen(false);
    setSelectedId(null);
    setSelectedClipId(null);
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
      />
      {safetyError ? <div className="safety-error-bar">{safetyError}</div> : null}
      <ImportZone onImported={handleImported} />
      <Timeline
        session={session}
        selectedOpId={selectedId}
        onSelect={selectOp}
        onConcatSuccess={refresh}
      />
      <main className="main">
        <OpList entries={session.entries} selectedId={selectedId} onSelect={selectOp} />
        <div className="stage">
          <Viewer key={timeline} timeline={timeline} atSec={playheadSec} rev={composition.rev} />
          <div className="stage-detail">
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
            ) : selected ? (
              <ClipInspector
                key={selected.clip.id}
                timeline={timeline}
                clip={selected.clip}
                mediaNames={names}
                playheadSec={playheadSec}
                hasNext={nextClipOnTrack(selected.track, selected.clip) !== null}
                canvasFit={composition.fit}
                trackMediaIds={selected.track.clips
                  .filter((c) => c.kind === 'media')
                  .map((c) => c.id)}
                busy={verbBusy}
                error={verbError}
                nextShortId={freeShortId}
                onApply={handleApplyVerbs}
                onMakeShort={handleMakeShort}
                onSeek={setPlayheadSec}
                onClose={() => setSelectedClipId(null)}
              />
            ) : (
              <DetailPane entry={selectedEntry} />
            )}
          </div>
        </div>
      </main>
      <TimelineTabs
        timelines={timelines}
        current={timeline}
        exportingAll={exportingAll}
        notice={notice}
        onSelect={openTimeline}
        onDelete={(id) => void handleDeleteTimeline(id)}
        onExportAll={() => void handleExportAll()}
        onDismissNotice={() => setNotice(null)}
      />
      <DocTimeline
        timeline={timeline}
        composition={composition}
        mediaNames={names}
        selectedClipId={selectedClipId}
        onSelectClip={selectClip}
        playheadSec={playheadSec}
        onScrub={setPlayheadSec}
        onExport={() => void handleExport()}
        exporting={verbBusy}
        onUndo={() => void handleTimelineHistory('undo')}
        onRedo={() => void handleTimelineHistory('redo')}
        onApply={handleApplyVerbs}
        verbError={verbError}
      />
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
