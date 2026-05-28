import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface ConcatResult {
  path: string;
  durationMs: number;
  inputCount: number;
}

/**
 * Stitches 2+ clips back-to-back. The row list is the v0.3 way to compose
 * the "screen-recordings + title cards in between" product-video workflow
 * without a visual timeline.
 */
export function ConcatForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  // Two empty rows is the minimum the schema allows; pre-seeding to two
  // lets the user start typing instead of clicking "Add input" first.
  const [inputs, setInputs] = useState<string[]>(['', '']);
  const { run, loading, error } = useRunTool<ConcatResult>('concat');

  function updateAt(i: number, value: string) {
    setInputs((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }
  function removeAt(i: number) {
    setInputs((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));
  }
  function addRow() {
    setInputs((prev) => [...prev, '']);
  }
  function moveUp(i: number) {
    if (i === 0) return;
    setInputs((prev) => {
      const next = [...prev];
      [next[i - 1], next[i]] = [next[i] as string, next[i - 1] as string];
      return next;
    });
  }
  function moveDown(i: number) {
    setInputs((prev) => {
      if (i >= prev.length - 1) return prev;
      const next = [...prev];
      [next[i], next[i + 1]] = [next[i + 1] as string, next[i] as string];
      return next;
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cleaned = inputs.map((s) => s.trim()).filter((s) => s.length > 0);
    const result = await run({ inputs: cleaned });
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Concat</h3>
      <p className="form-hint">
        Stitches files back-to-back in the listed order. Best when sources share codec/
        resolution/fps — re-encode mismatched clips with <code>render</code> first.
      </p>

      <FormField label="Inputs (in order)" hint="Two or more files. Use ↑/↓ to reorder.">
        <div className="row-list">
          {inputs.map((value, i) => (
            // Using array index as key is fine here — list size only changes
            // through add/remove buttons we control, and rows are otherwise
            // identical in shape, so stale keys don't cause visual issues.
            // biome-ignore lint/suspicious/noArrayIndexKey: stable row list, identical row shape
            <div className="row" key={i}>
              <span className="row-index">{i + 1}.</span>
              <div className="row-input">
                <PathPicker
                  value={value}
                  onChange={(v) => updateAt(i, v)}
                  session={session}
                  listId={`concat-input-${i}`}
                />
              </div>
              <div className="row-buttons">
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => moveUp(i)}
                  disabled={i === 0}
                  aria-label="Move up"
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => moveDown(i)}
                  disabled={i === inputs.length - 1}
                  aria-label="Move down"
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => removeAt(i)}
                  disabled={inputs.length <= 2}
                  aria-label="Remove row"
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="btn-secondary btn-add-row" onClick={addRow}>
          + Add input
        </button>
      </FormField>

      <FormActions
        loading={loading}
        error={error?.message ?? null}
        onCancel={onCancel}
        submitLabel="Concat"
      />
    </form>
  );
}
