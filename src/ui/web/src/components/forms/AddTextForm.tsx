import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface AddTextResult {
  path: string;
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

export function AddTextForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [text, setText] = useState('');
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>('bottom-center');
  const [startSec, setStartSec] = useState('0');
  const [endSec, setEndSec] = useState('5');
  const { run, loading, error } = useRunTool<AddTextResult>('add_text');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await run({
      input,
      text,
      position,
      startSec: Number(startSec),
      endSec: Number(endSec),
    });
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Add text overlay</h3>

      <FormField label="Input">
        <PathPicker
          value={input}
          onChange={setInput}
          session={session}
          listId="add-text-input-paths"
        />
      </FormField>

      <FormField label="Text" hint="What to display. Quotes, colons, unicode all OK.">
        <input
          type="text"
          className="form-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Best of last week"
          maxLength={500}
        />
      </FormField>

      <FormField label="Position">
        <select
          className="form-input"
          value={position}
          onChange={(e) => setPosition(e.target.value as (typeof POSITIONS)[number])}
        >
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </FormField>

      <div className="form-row">
        <FormField label="Start (sec)">
          <input
            type="number"
            step="0.1"
            min="0"
            className="form-input"
            value={startSec}
            onChange={(e) => setStartSec(e.target.value)}
          />
        </FormField>
        <FormField label="End (sec)">
          <input
            type="number"
            step="0.1"
            min="0.1"
            className="form-input"
            value={endSec}
            onChange={(e) => setEndSec(e.target.value)}
          />
        </FormField>
      </div>

      <FormActions loading={loading} error={error?.message ?? null} onCancel={onCancel} />
    </form>
  );
}
