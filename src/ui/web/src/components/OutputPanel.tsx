import { useEffect, useRef, useState } from 'react';
import type { Verb } from '../lib/verbs.js';
import type { Composition } from '../types.js';
import { Choice } from './Choice.js';

const SHAPES = [
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '1:1', ratio: 1 },
  { label: '4:5', ratio: 4 / 5 },
] as const;
const FILLS = [
  { label: 'Fill frame', fit: 'cover' },
  { label: 'Show all', fit: 'contain' },
] as const;

type ShapeLabel = (typeof SHAPES)[number]['label'];
type FillLabel = (typeof FILLS)[number]['label'];

/** The preset a canvas matches (presets round the long side to even pixels). */
function shapeOf(width: number, height: number): ShapeLabel | null {
  return SHAPES.find((s) => Math.abs(width / height - s.ratio) < 0.01)?.label ?? null;
}

function fillOf(fit: Composition['fit']): FillLabel {
  return FILLS.find((f) => f.fit === fit)?.label ?? 'Show all';
}

/**
 * The timeline's Output button and its panel: the canvas shape (16:9, 9:16,
 * 1:1, 4:5) and how clips fill it, as one undoable `reframe` edit. What part of
 * each clip shows is set per clip in its inspector.
 */
export function OutputPanel({
  composition,
  busy,
  error,
  onApply,
}: {
  composition: Composition;
  busy: boolean;
  /** The last verb error, shown while the panel is open. */
  error: string | null;
  onApply: (verbs: Verb[]) => Promise<number | null>;
}) {
  const current = shapeOf(composition.width, composition.height);
  const [open, setOpen] = useState(false);
  const [shape, setShape] = useState<ShapeLabel>(current ?? '16:9');
  const [fill, setFill] = useState<FillLabel>(fillOf(composition.fit));
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

  const toggle = () => {
    // Opening starts from the timeline as it is now, not the last unapplied pick.
    if (!open) {
      setShape(current ?? '16:9');
      setFill(fillOf(composition.fit));
    }
    setOpen((o) => !o);
    setNote(null);
    setFailed(false);
  };

  const apply = async () => {
    setNote(null);
    setFailed(false);
    const fit = FILLS.find((f) => f.label === fill)?.fit;
    const applied = await onApply([{ verb: 'reframe', aspect: shape, fit }]);
    if (applied === null) setFailed(true);
    else if (applied === 0) setNote('The timeline is already this shape.');
    else setOpen(false);
  };

  return (
    <div className="cap-root" ref={root}>
      <button
        type="button"
        className="btn-secondary cap-btn"
        aria-expanded={open}
        onClick={toggle}
        title="Output shape: 16:9, vertical 9:16, square or 4:5"
      >
        Output {current ?? `${composition.width}×${composition.height}`}
      </button>
      {open ? (
        <div className="cap-panel" role="dialog" aria-label="Output">
          <Choice label="Shape" options={SHAPES} value={shape} onChange={setShape} />
          <Choice label="Fill" options={FILLS} value={fill} onChange={setFill} />
          <p className="form-hint">
            {fill === 'Fill frame'
              ? 'Clips fill the frame and the overflow is cropped. Pick the part that shows in each clip’s Framing.'
              : 'Clips show whole, with bars where their shape differs.'}{' '}
            Undo restores the old shape.
          </p>
          {failed && error ? <div className="form-error">{error}</div> : null}
          {note ? <p className="form-hint">{note}</p> : null}
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void apply()}
          >
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}
