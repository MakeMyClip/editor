import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface HighlightReelResult {
  path: string;
  segmentCount: number;
  transitionCount: number;
  durationMs: number;
}

const TRANSITION_KINDS = [
  'none',
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'slideleft',
  'slideright',
  'circleopen',
  'circleclose',
] as const;

interface SegmentRow {
  startSec: string;
  endSec: string;
}

export function HighlightReelForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [segments, setSegments] = useState<SegmentRow[]>([
    { startSec: '', endSec: '' },
    { startSec: '', endSec: '' },
  ]);
  const [transitionKind, setTransitionKind] = useState<(typeof TRANSITION_KINDS)[number]>('none');
  const [transitionSec, setTransitionSec] = useState('0.5');
  const { run, loading, error } = useRunTool<HighlightReelResult>('highlight_reel');

  function updateRow(i: number, patch: Partial<SegmentRow>) {
    setSegments((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeRow(i: number) {
    setSegments((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));
  }
  function addRow() {
    setSegments((prev) => [...prev, { startSec: '', endSec: '' }]);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      input,
      segments: segments
        .filter((s) => s.startSec !== '' && s.endSec !== '')
        .map((s) => ({ startSec: Number(s.startSec), endSec: Number(s.endSec) })),
      transitionSec: Number(transitionSec),
    };
    // 'none' is the form's convention for "no transition" — the schema is
    // `.optional()`, so we omit the field entirely when none is selected.
    if (transitionKind !== 'none') payload.transitionKind = transitionKind;

    const result = await run(payload);
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Highlight reel</h3>
      <p className="form-hint">
        Extracts two or more time ranges and stitches them in order — optionally with a transition
        between segments.
      </p>

      <FormField label="Input">
        <PathPicker value={input} onChange={setInput} session={session} listId="reel-input-paths" />
      </FormField>

      <FormField label="Segments" hint="Time ranges in source. Each cut runs in segment order.">
        <div className="row-list">
          {segments.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable row list
            <div className="row row-segment" key={i}>
              <span className="row-index">{i + 1}.</span>
              <input
                type="number"
                step="0.1"
                min="0"
                className="form-input"
                placeholder="start"
                value={row.startSec}
                onChange={(e) => updateRow(i, { startSec: e.target.value })}
              />
              <span className="row-arrow">→</span>
              <input
                type="number"
                step="0.1"
                min="0"
                className="form-input"
                placeholder="end"
                value={row.endSec}
                onChange={(e) => updateRow(i, { endSec: e.target.value })}
              />
              <button
                type="button"
                className="btn-icon"
                onClick={() => removeRow(i)}
                disabled={segments.length <= 2}
                aria-label="Remove segment"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn-secondary btn-add-row" onClick={addRow}>
          + Add segment
        </button>
      </FormField>

      <div className="form-row">
        <FormField label="Transition kind">
          <select
            className="form-input"
            value={transitionKind}
            onChange={(e) => setTransitionKind(e.target.value as (typeof TRANSITION_KINDS)[number])}
          >
            {TRANSITION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Transition (sec)" hint="0.1 – 5">
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="5"
            className="form-input"
            value={transitionSec}
            onChange={(e) => setTransitionSec(e.target.value)}
            disabled={transitionKind === 'none'}
          />
        </FormField>
      </div>

      <FormActions
        loading={loading}
        error={error?.message ?? null}
        onCancel={onCancel}
        submitLabel="Render reel"
      />
    </form>
  );
}
