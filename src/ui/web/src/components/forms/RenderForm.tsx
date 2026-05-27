import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface RenderResult {
  path: string;
  format: string;
  durationMs: number;
}

const FORMATS = ['mp4', 'mov', 'webm'] as const;
const PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const;

export function RenderForm({
  session,
  onSuccess,
  onCancel,
}: {
  session: Session;
  onSuccess: (newOpPath: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('mp4');
  const [crf, setCrf] = useState('23');
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>('medium');
  const [maxWidth, setMaxWidth] = useState('');
  const { run, loading, error } = useRunTool<RenderResult>('render');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      input,
      format,
      crf: Number(crf),
      preset,
    };
    if (maxWidth.trim()) body.maxWidth = Number(maxWidth);
    const result = await run(body);
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Render</h3>

      <FormField label="Input">
        <PathPicker
          value={input}
          onChange={setInput}
          session={session}
          listId="render-input-paths"
        />
      </FormField>

      <div className="form-row">
        <FormField label="Format">
          <select
            className="form-input"
            value={format}
            onChange={(e) => setFormat(e.target.value as (typeof FORMATS)[number])}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="CRF" hint="0 (lossless) – 51 (worst). Default 23.">
          <input
            type="number"
            min="0"
            max="51"
            className="form-input"
            value={crf}
            onChange={(e) => setCrf(e.target.value)}
          />
        </FormField>
      </div>

      <div className="form-row">
        <FormField label="Preset" hint="Ignored for webm.">
          <select
            className="form-input"
            value={preset}
            onChange={(e) => setPreset(e.target.value as (typeof PRESETS)[number])}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Max width (optional)" hint="Pixels. Preserves aspect; never upscales.">
          <input
            type="number"
            min="1"
            className="form-input"
            value={maxWidth}
            onChange={(e) => setMaxWidth(e.target.value)}
            placeholder="(no resize)"
          />
        </FormField>
      </div>

      <FormActions loading={loading} error={error?.message ?? null} onCancel={onCancel} />
    </form>
  );
}
