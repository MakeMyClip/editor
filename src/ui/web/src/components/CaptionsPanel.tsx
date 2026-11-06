import { useEffect, useRef, useState } from 'react';
import type { Verb } from '../lib/verbs.js';

const SHOW = [
  { label: 'Phrases', maxWords: undefined },
  { label: 'Words', maxWords: 1 },
] as const;
const POSITION = [
  { label: 'Bottom', anchor: 'bottom-center' },
  { label: 'Middle', anchor: 'center' },
  { label: 'Top', anchor: 'top-center' },
] as const;
const LOOK = [
  { label: 'Box', color: 'white', background: 'black@0.6' },
  { label: 'Plain', color: 'white', background: null },
  { label: 'Yellow', color: 'yellow', background: 'black@0.6' },
] as const;

/**
 * The timeline's Captions button and its panel: caption every transcribed clip
 * from its stored transcript, as one undoable edit that replaces the caption
 * track. The choices map onto the `caption_speech` verb's options.
 */
export function CaptionsPanel({
  busy,
  error,
  onApply,
}: {
  busy: boolean;
  /** The last verb error, shown while the panel is open. */
  error: string | null;
  onApply: (verbs: Verb[]) => Promise<number | null>;
}) {
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState<(typeof SHOW)[number]['label']>('Phrases');
  const [position, setPosition] = useState<(typeof POSITION)[number]['label']>('Bottom');
  const [look, setLook] = useState<(typeof LOOK)[number]['label']>('Box');
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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

  const caption = async () => {
    setNote(null);
    setFailed(false);
    const maxWords = SHOW.find((s) => s.label === show)?.maxWords;
    const anchor = POSITION.find((p) => p.label === position)?.anchor;
    const style = LOOK.find((l) => l.label === look);
    const applied = await onApply([
      {
        verb: 'caption_speech',
        ...(maxWords !== undefined ? { maxWords } : {}),
        anchor,
        color: style?.color,
        background: style?.background ?? null,
      },
    ]);
    if (applied === null) setFailed(true);
    else if (applied === 0) setNote('No speech found to caption.');
    else setOpen(false);
  };

  return (
    <div className="cap-root" ref={root}>
      <button
        type="button"
        className="btn-secondary cap-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setNote(null);
          setFailed(false);
        }}
        title="Caption the speech from the clips' transcripts"
      >
        CC Captions
      </button>
      {open ? (
        <div className="cap-panel" role="dialog" aria-label="Captions">
          <Choice label="Show" options={SHOW} value={show} onChange={setShow} />
          <Choice label="Position" options={POSITION} value={position} onChange={setPosition} />
          <Choice label="Look" options={LOOK} value={look} onChange={setLook} />
          <p className="form-hint">
            Uses the clips' transcripts (transcribe a clip from its inspector first) and replaces
            the captions already there. Undo restores them.
          </p>
          {failed && error ? <div className="form-error">{error}</div> : null}
          {note ? <p className="form-hint">{note}</p> : null}
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void caption()}
          >
            {busy ? 'Captioning…' : 'Caption all clips'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Choice<L extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { label: L }[];
  value: L;
  onChange: (value: L) => void;
}) {
  return (
    <fieldset className="cap-row" aria-label={label}>
      <span className="cap-row-label">{label}</span>
      {options.map((o) => (
        <button
          type="button"
          key={o.label}
          className={`cap-seg${o.label === value ? ' is-on' : ''}`}
          aria-pressed={o.label === value}
          onClick={() => onChange(o.label)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
