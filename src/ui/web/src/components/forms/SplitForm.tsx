import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface SplitResult {
  before: string;
  after: string;
  durationMs: number;
}

export function SplitForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [atSec, setAtSec] = useState('');
  const { run, loading, error } = useRunTool<SplitResult>('split');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await run({ input, atSec: Number(atSec) });
    if (result) onSuccess(result.before);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Split</h3>

      <FormField label="Input">
        <PathPicker
          value={input}
          onChange={setInput}
          session={session}
          listId="split-input-paths"
        />
      </FormField>

      <FormField label="Split point" hint="Seconds from the start of the clip.">
        <input
          type="number"
          step="0.1"
          min="0.001"
          className="form-input"
          value={atSec}
          onChange={(e) => setAtSec(e.target.value)}
          placeholder="2.5"
        />
      </FormField>

      <FormActions loading={loading} error={error?.message ?? null} onCancel={onCancel} />
    </form>
  );
}
