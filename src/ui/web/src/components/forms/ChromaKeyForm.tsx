import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface ChromaKeyResult {
  path: string;
  durationMs: number;
}

const COLORS = ['green', 'blue', 'red', 'cyan', 'magenta', 'yellow', 'black', 'white'] as const;

export function ChromaKeyForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [foreground, setForeground] = useState('');
  const [background, setBackground] = useState('');
  const [color, setColor] = useState<(typeof COLORS)[number] | string>('green');
  const [similarity, setSimilarity] = useState('0.3');
  const [blend, setBlend] = useState('0.1');
  const [preferForegroundAudio, setPreferForegroundAudio] = useState(false);
  const { run, loading, error } = useRunTool<ChromaKeyResult>('chroma_key');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await run({
      foreground,
      background,
      color,
      similarity: Number(similarity),
      blend: Number(blend),
      preferForegroundAudio,
    });
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Chroma key</h3>
      <p className="form-hint">
        Key out a flat color from the foreground and composite over the background. Background can
        be a video or a still image (auto-detected, looped to foreground length).
      </p>

      <FormField label="Foreground" hint="Video with the color to remove.">
        <PathPicker
          value={foreground}
          onChange={setForeground}
          session={session}
          listId="chroma-fg-paths"
        />
      </FormField>

      <FormField label="Background" hint="Video or still image to composite over.">
        <PathPicker
          value={background}
          onChange={setBackground}
          session={session}
          listId="chroma-bg-paths"
        />
      </FormField>

      <FormField label="Key color" hint="Pick a preset or type #RRGGBB.">
        <input
          type="text"
          className="form-input"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          list="chroma-color-presets"
          placeholder="green"
        />
        <datalist id="chroma-color-presets">
          {COLORS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </FormField>

      <div className="form-row">
        <FormField label="Similarity" hint="0 = exact, 1 = almost anything.">
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            className="form-input"
            value={similarity}
            onChange={(e) => setSimilarity(e.target.value)}
          />
        </FormField>
        <FormField label="Edge blend" hint="0 = hard, 1 = very soft. 0.1 ≈ natural.">
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            className="form-input"
            value={blend}
            onChange={(e) => setBlend(e.target.value)}
          />
        </FormField>
      </div>

      <FormField label="Audio source" hint="Default is background audio.">
        <label className="form-checkbox-line">
          <input
            type="checkbox"
            checked={preferForegroundAudio}
            onChange={(e) => setPreferForegroundAudio(e.target.checked)}
          />
          Use audio from the foreground instead
        </label>
      </FormField>

      <FormActions
        loading={loading}
        error={error?.message ?? null}
        onCancel={onCancel}
        submitLabel="Render composite"
      />
    </form>
  );
}
