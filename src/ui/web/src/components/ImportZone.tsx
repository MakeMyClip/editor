import { type DragEvent, useRef, useState } from 'react';
import { useImport } from '../hooks/useImport.js';

/**
 * Drag-drop file area + Browse button. Posts to /api/import — the server
 * streams files into the workspace and runs ingest per file. Calls
 * `onImported` after a successful upload so the parent can refresh the
 * session list.
 *
 * Drag events bubble up from anywhere on the page when `pageWide` is true,
 * not just on the drop area — matches the "drop anywhere" UX users expect
 * from file-import surfaces.
 */
export function ImportZone({ onImported }: { onImported: () => void }) {
  const { run, loading, error, lastImported } = useImport();
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function onDragOver(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }
  function onDragLeave(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }
  async function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const result = await run(files);
    if (result && result.length > 0) onImported();
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const result = await run(files);
    if (result && result.length > 0) onImported();
    // Reset so picking the same file twice in a row still triggers change.
    e.target.value = '';
  }

  return (
    <section
      className={`import-zone${dragActive ? ' import-zone-active' : ''}`}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label="Drop files to import"
    >
      <div className="import-zone-prompt">
        {loading ? (
          <span>Importing…</span>
        ) : (
          <>
            <strong>Drop video, audio, or image files here</strong>
            <span className="import-zone-sub"> or </span>
            <button
              type="button"
              className="btn-secondary import-zone-browse"
              onClick={() => inputRef.current?.click()}
              disabled={loading}
            >
              Browse…
            </button>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        // Restrict to media-ish extensions to discourage uploading unrelated
        // files; users can still type any path into the path picker afterward.
        accept="video/*,audio/*,image/*"
        onChange={onPick}
        style={{ display: 'none' }}
      />
      {error ? <div className="import-zone-error">{error}</div> : null}
      {!error && lastImported.length > 0 && !loading ? (
        <div className="import-zone-recent">
          Imported {lastImported.length} file{lastImported.length === 1 ? '' : 's'}:{' '}
          {lastImported.map((f) => f.originalName).join(', ')}
        </div>
      ) : null}
    </section>
  );
}
