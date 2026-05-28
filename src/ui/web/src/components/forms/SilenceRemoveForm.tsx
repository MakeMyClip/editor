import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface SilenceRemoveResult {
  path: string;
  silenceCount: number;
  keptRegionCount: number;
  durationMs: number;
}

export function SilenceRemoveForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [noiseDb, setNoiseDb] = useState('-30');
  const [minSilenceSec, setMinSilenceSec] = useState('0.5');
  const { run, loading, error } = useRunTool<SilenceRemoveResult>('silence_remove');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await run({
      input,
      noiseDb: Number(noiseDb),
      minSilenceSec: Number(minSilenceSec),
    });
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Remove silence</h3>
      <p className="form-hint">
        Detects and cuts silent stretches from a video with audio. Wraps the OSS{' '}
        <code>auto-editor</code> pattern — produces one output with the silences trimmed out.
      </p>

      <FormField label="Input">
        <PathPicker
          value={input}
          onChange={setInput}
          session={session}
          listId="silence-input-paths"
        />
      </FormField>

      <div className="form-row">
        <FormField
          label="Noise threshold (dB)"
          hint="Quieter than this counts as silence. -30 is usually right."
        >
          <input
            type="number"
            step="1"
            max="0"
            className="form-input"
            value={noiseDb}
            onChange={(e) => setNoiseDb(e.target.value)}
          />
        </FormField>
        <FormField
          label="Min silence (sec)"
          hint="Shorter silences are kept (so cuts don't feel choppy)."
        >
          <input
            type="number"
            step="0.1"
            min="0.1"
            className="form-input"
            value={minSilenceSec}
            onChange={(e) => setMinSilenceSec(e.target.value)}
          />
        </FormField>
      </div>

      <FormActions
        loading={loading}
        error={error?.message ?? null}
        onCancel={onCancel}
        submitLabel="Remove silence"
      />
    </form>
  );
}
