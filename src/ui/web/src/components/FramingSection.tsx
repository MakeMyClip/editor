import { useState } from 'react';
import type { Verb } from '../lib/verbs.js';
import type { Fit, MediaClip } from '../types.js';
import { Choice } from './Choice.js';

const FITS = [
  { label: 'Timeline', fit: 'inherit' },
  { label: 'Fill', fit: 'cover' },
  { label: 'Show all', fit: 'contain' },
] as const;
type FitLabel = (typeof FITS)[number]['label'];

const MAX_ZOOM = 4;

/**
 * A media clip's framing: its own fit (or the timeline's), zoom and position.
 * Edits stay local until Apply, so dragging a slider doesn't add an undo step
 * and re-render the frame on every tick. Mounted per framing (keyed by it), so
 * an undo or a reset shows the document's values again.
 */
export function FramingSection({
  clip,
  canvasFit,
  trackMediaIds,
  busy,
  onApply,
}: {
  clip: MediaClip;
  canvasFit: Fit;
  /** Media clips on this clip's track, for "Apply to all clips". */
  trackMediaIds: string[];
  busy: boolean;
  onApply: (verbs: Verb[]) => Promise<number | null>;
}) {
  const t = clip.transform ?? {};
  const [fit, setFit] = useState<FitLabel>(
    FITS.find((f) => f.fit === (t.fit ?? 'inherit'))?.label ?? 'Timeline',
  );
  const [x, setX] = useState(t.x ?? 0.5);
  const [y, setY] = useState(t.y ?? 0.5);
  const [scale, setScale] = useState(t.scale ?? 1);
  const [note, setNote] = useState<string | null>(null);

  const effectiveFit = fit === 'Timeline' ? canvasFit : fit === 'Fill' ? 'cover' : 'contain';
  const framing = (clipId: string): Verb => ({
    verb: 'set_framing',
    clipId,
    fit: FITS.find((f) => f.label === fit)?.fit,
    scale,
    x,
    y,
  });

  const apply = async (verbs: Verb[]) => {
    setNote(null);
    const applied = await onApply(verbs);
    if (applied === 0) setNote('Nothing to change.');
  };

  return (
    <div className="ci-section">
      <div className="ci-section-title">Framing</div>
      <Choice label="Fit" options={FITS} value={fit} onChange={setFit} />
      <Slider label="Left–right" value={x} min={0} max={1} step={0.01} onChange={setX} percent />
      <Slider label="Up–down" value={y} min={0} max={1} step={0.01} onChange={setY} percent />
      <Slider
        label="Zoom"
        value={scale}
        min={Math.min(1, t.scale ?? 1)}
        max={MAX_ZOOM}
        step={0.05}
        onChange={setScale}
      />
      <p className="form-hint">
        {effectiveFit === 'cover'
          ? 'The clip fills the frame; position picks the part that shows (0% = its left or top edge).'
          : 'The clip shows whole; position moves it inside the bars.'}
      </p>
      {note ? <p className="form-hint">{note}</p> : null}
      <div className="ci-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => void apply([framing(clip.id)])}
        >
          Apply
        </button>
        {trackMediaIds.length > 1 ? (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void apply(trackMediaIds.map(framing))}
            title="Frame every media clip on this track the same way, as one undo step"
          >
            Apply to all clips
          </button>
        ) : null}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || clip.transform === undefined}
          onClick={() => void apply([{ verb: 'set_framing', clipId: clip.id, reset: true }])}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  percent = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  percent?: boolean;
}) {
  return (
    <label className="ci-slider">
      <span className="cap-row-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="ci-slider-value">
        {percent ? `${Math.round(value * 100)}%` : `${value.toFixed(2)}×`}
      </span>
    </label>
  );
}
