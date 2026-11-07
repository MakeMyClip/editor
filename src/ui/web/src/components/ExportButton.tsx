import { useEffect, useRef, useState } from 'react';

type ProjectFormat = 'fcpxml' | 'xmeml';

interface ProjectExport {
  files: string[];
  durationSec: number;
  notes: string[];
}

const PROJECTS: readonly { format: ProjectFormat; label: string; detail: string }[] = [
  { format: 'fcpxml', label: 'Final Cut Pro / Resolve', detail: '.fcpxml project' },
  { format: 'xmeml', label: 'Premiere Pro', detail: '.xml project + .srt captions' },
];

/** POST the export route for an editor project; throws with the server's
 *  message (e.g. the 422 naming what the project can't hold). */
async function exportProject(format: ProjectFormat): Promise<ProjectExport> {
  const res = await fetch('/api/timeline/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format }),
  });
  const json = (await res.json()) as Partial<ProjectExport> & { error?: string };
  if (!res.ok || !json.files) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { files: json.files, durationSec: json.durationSec ?? 0, notes: json.notes ?? [] };
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * The timeline's split Export button. The main part renders the video and plays
 * it, as before; the caret opens a menu that also writes a project file for
 * Final Cut Pro, Resolve or Premiere, and shows where it went and what it
 * carries only in part.
 */
export function ExportButton({
  busy,
  disabled,
  onExportVideo,
}: {
  busy: boolean;
  disabled: boolean;
  onExportVideo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<ProjectFormat | null>(null);
  const [result, setResult] = useState<ProjectExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const exportAs = async (format: ProjectFormat) => {
    setWorking(format);
    setResult(null);
    setError(null);
    setCopied(false);
    try {
      setResult(await exportProject(format));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const blocked = disabled || busy || working !== null;
  const main = result?.files[0];

  return (
    <div className="exp-root" ref={root}>
      <button
        type="button"
        className="btn-primary exp-main"
        onClick={onExportVideo}
        disabled={blocked}
        title="Render the timeline to an mp4 and play it"
      >
        {busy ? 'Exporting…' : 'Export ▸'}
      </button>
      <button
        type="button"
        className="btn-primary exp-caret"
        aria-label="More export formats"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          setResult(null);
          setError(null);
        }}
      >
        ▾
      </button>
      {open ? (
        <div className="exp-menu" role="menu" aria-label="Export formats">
          <button
            type="button"
            role="menuitem"
            className="exp-item"
            disabled={blocked}
            onClick={() => {
              setOpen(false);
              onExportVideo();
            }}
          >
            Video (.mp4)
            <small>Render and play it here</small>
          </button>
          {PROJECTS.map((p) => (
            <button
              type="button"
              role="menuitem"
              key={p.format}
              className="exp-item"
              disabled={blocked}
              onClick={() => void exportAs(p.format)}
            >
              {working === p.format ? 'Exporting…' : p.label}
              <small>{p.detail}</small>
            </button>
          ))}
          {error ? <div className="form-error">{error}</div> : null}
          {result && main ? (
            <div className="exp-result">
              <div className="exp-saved">
                Saved {result.files.map(fileName).join(' + ')} · {result.durationSec.toFixed(2)}s
              </div>
              <code className="exp-path">{main}</code>
              {result.notes.map((note) => (
                <p className="form-hint" key={note}>
                  {note}
                </p>
              ))}
              <p className="form-hint">
                It points at your source files, so keep them where they are.
              </p>
              <button
                type="button"
                className="btn-secondary exp-copy"
                onClick={() => void copyPath(main)}
              >
                {copied ? 'Copied' : 'Copy path'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
