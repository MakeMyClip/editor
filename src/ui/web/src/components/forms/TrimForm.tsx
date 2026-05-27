import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';

interface TrimResult {
  path: string;
  durationMs: number;
}

export function TrimForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [start, setStart] = useState('00:00:00');
  const [end, setEnd] = useState('');
  const { run, loading, error } = useRunTool<TrimResult>('trim');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await run({ input, start, end });
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Trim</h3>

      <FormField label="Input" hint="Path to source video, or pick a prior op output.">
        <PathPicker value={input} onChange={setInput} session={session} listId="trim-input-paths" />
      </FormField>

      <FormField label="Start" hint="HH:MM:SS[.ms], MM:SS, or seconds.">
        <input
          type="text"
          className="form-input"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          placeholder="00:00:00"
        />
      </FormField>

      <FormField label="End" hint="Must be after start.">
        <input
          type="text"
          className="form-input"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          placeholder="00:00:05"
        />
      </FormField>

      <FormActions loading={loading} error={error?.message ?? null} onCancel={onCancel} />
    </form>
  );
}

export function FormActions({
  loading,
  error,
  onCancel,
  submitLabel = 'Run',
}: {
  loading: boolean;
  error: string | null;
  onCancel: () => void;
  submitLabel?: string;
}) {
  return (
    <>
      {error ? <div className="form-error">{error}</div> : null}
      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Running…' : submitLabel}
        </button>
      </div>
    </>
  );
}
