import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface AddCaptionsResult {
  path: string;
  cueCount: number;
  durationMs: number;
}

const POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

interface CueRow {
  text: string;
  startSec: string;
  endSec: string;
  position: (typeof POSITIONS)[number];
}

export function AddCaptionsForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [cues, setCues] = useState<CueRow[]>([
    { text: '', startSec: '', endSec: '', position: 'bottom-center' },
  ]);
  const { run, loading, error } = useRunTool<AddCaptionsResult>('add_captions');

  function updateRow(i: number, patch: Partial<CueRow>) {
    setCues((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeRow(i: number) {
    setCues((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }
  function addRow() {
    setCues((prev) => [...prev, { text: '', startSec: '', endSec: '', position: 'bottom-center' }]);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await run({
      input,
      cues: cues
        .filter((c) => c.text !== '' && c.startSec !== '' && c.endSec !== '')
        .map((c) => ({
          text: c.text,
          startSec: Number(c.startSec),
          endSec: Number(c.endSec),
          position: c.position,
        })),
    });
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Add captions</h3>
      <p className="form-hint">
        Burns one or more text cues into the video at specific timecodes. Does not transcribe — pass
        cues you already have (e.g. from a transcript, or written by hand).
      </p>

      <FormField label="Input">
        <PathPicker
          value={input}
          onChange={setInput}
          session={session}
          listId="captions-input-paths"
        />
      </FormField>

      <FormField label="Cues" hint="One row per caption.">
        <div className="row-list">
          {cues.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable row list
            <div className="row row-cue" key={i}>
              <span className="row-index">{i + 1}.</span>
              <div className="row-cue-fields">
                <input
                  type="text"
                  className="form-input"
                  placeholder="Caption text"
                  maxLength={500}
                  value={row.text}
                  onChange={(e) => updateRow(i, { text: e.target.value })}
                />
                <div className="row-cue-meta">
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
                  <select
                    className="form-input"
                    value={row.position}
                    onChange={(e) =>
                      updateRow(i, { position: e.target.value as (typeof POSITIONS)[number] })
                    }
                  >
                    {POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <button
                type="button"
                className="btn-icon"
                onClick={() => removeRow(i)}
                disabled={cues.length <= 1}
                aria-label="Remove cue"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn-secondary btn-add-row" onClick={addRow}>
          + Add cue
        </button>
      </FormField>

      <FormActions
        loading={loading}
        error={error?.message ?? null}
        onCancel={onCancel}
        submitLabel="Burn captions"
      />
    </form>
  );
}
