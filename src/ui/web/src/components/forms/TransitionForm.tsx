import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface TransitionResult {
  path: string;
  durationMs: number;
}

const KINDS = [
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'circleopen',
  'circleclose',
] as const;

export function TransitionForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [inputA, setInputA] = useState('');
  const [inputB, setInputB] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('fade');
  const [durationSec, setDurationSec] = useState('1');
  const { run, loading, error } = useRunTool<TransitionResult>('transition');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await run({
      inputA,
      inputB,
      kind,
      durationSec: Number(durationSec),
    });
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Transition between two clips</h3>

      <FormField label="Clip A" hint="The clip that ends; transition starts in its last seconds.">
        <PathPicker
          value={inputA}
          onChange={setInputA}
          session={session}
          listId="transition-a-paths"
        />
      </FormField>

      <FormField label="Clip B" hint="The clip that comes next.">
        <PathPicker
          value={inputB}
          onChange={setInputB}
          session={session}
          listId="transition-b-paths"
        />
      </FormField>

      <div className="form-row">
        <FormField label="Kind">
          <select
            className="form-input"
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Duration (sec)">
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="10"
            className="form-input"
            value={durationSec}
            onChange={(e) => setDurationSec(e.target.value)}
          />
        </FormField>
      </div>

      <FormActions loading={loading} error={error?.message ?? null} onCancel={onCancel} />
    </form>
  );
}
