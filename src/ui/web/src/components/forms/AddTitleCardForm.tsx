import { type FormEvent, useState } from 'react';
import { useRunTool } from '../../hooks/useRunTool.js';
import type { Session } from '../../types.js';
import { FormField } from '../FormField.js';
import { PathPicker } from '../PathPicker.js';
import { FormActions } from './TrimForm.js';

interface AddTitleCardResult {
  path: string;
  durationMs: number;
}

export function AddTitleCardForm({
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
  const [durationSec, setDurationSec] = useState('2');
  const [background, setBackground] = useState('black');
  const [fontSize, setFontSize] = useState('72');
  const [fontColor, setFontColor] = useState('white');
  const { run, loading, error } = useRunTool<AddTitleCardResult>('add_title_card');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await run({
      input,
      text,
      durationSec: Number(durationSec),
      background,
      fontSize: Number(fontSize),
      fontColor,
    });
    if (result) onSuccess(result.path);
  }

  return (
    <form className="tool-form" onSubmit={handleSubmit}>
      <h3>Add title card</h3>
      <p className="form-hint">
        Renders a colored card with centered text and prepends it to the input video. Background can
        be a CSS color name (<code>black</code>, <code>white</code>) or <code>#RRGGBB</code>.
      </p>

      <FormField label="Input">
        <PathPicker
          value={input}
          onChange={setInput}
          session={session}
          listId="title-card-input-paths"
        />
      </FormField>

      <FormField label="Title text" hint="Max 120 characters.">
        <input
          type="text"
          className="form-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Demo 1: Recording"
          maxLength={120}
        />
      </FormField>

      <div className="form-row">
        <FormField label="Duration (sec)" hint="0.1 – 15">
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="15"
            className="form-input"
            value={durationSec}
            onChange={(e) => setDurationSec(e.target.value)}
          />
        </FormField>
        <FormField label="Background" hint="Color name or #RRGGBB.">
          <input
            type="text"
            className="form-input"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="black"
          />
        </FormField>
      </div>

      <div className="form-row">
        <FormField label="Font size" hint="12 – 300 px.">
          <input
            type="number"
            min="12"
            max="300"
            step="1"
            className="form-input"
            value={fontSize}
            onChange={(e) => setFontSize(e.target.value)}
          />
        </FormField>
        <FormField label="Font color">
          <input
            type="text"
            className="form-input"
            value={fontColor}
            onChange={(e) => setFontColor(e.target.value)}
            placeholder="white"
          />
        </FormField>
      </div>

      <FormActions
        loading={loading}
        error={error?.message ?? null}
        onCancel={onCancel}
        submitLabel="Render title card"
      />
    </form>
  );
}
