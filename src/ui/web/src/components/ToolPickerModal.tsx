interface ToolMeta {
  name: string;
  label: string;
  description: string;
}

// Tools the UI has hand-built forms for. The backend supports more, but
// these are the ones the modal exposes. Add to this list as forms ship.
const TOOLS_WITH_FORMS: ToolMeta[] = [
  {
    name: 'trim',
    label: 'Trim',
    description: 'Cut a clip between two timecodes (stream-copy, no re-encode).',
  },
  {
    name: 'split',
    label: 'Split',
    description: 'Divide a clip at a point into before + after halves.',
  },
  {
    name: 'concat',
    label: 'Concat',
    description: 'Stitch two or more clips back-to-back in order.',
  },
  {
    name: 'add_text',
    label: 'Add text',
    description: 'Burn a caption or title overlay onto the video.',
  },
  {
    name: 'add_title_card',
    label: 'Add title card',
    description: 'Prepend a colored card with centered text to a clip.',
  },
  {
    name: 'transition',
    label: 'Transition',
    description: 'Crossfade, slide, or fade between two clips.',
  },
  {
    name: 'render',
    label: 'Render',
    description: 'Re-encode to a specific format / quality / size.',
  },
];

export function ToolPickerModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (toolName: string) => void;
}) {
  if (!open) return null;

  return (
    // The backdrop is a click-to-dismiss affordance, not a control. We model
    // it as a button so Biome's a11y rule is satisfied while keeping the
    // visual behavior identical.
    <div className="modal-backdrop">
      <button
        type="button"
        className="modal-backdrop-button"
        aria-label="Close dialog"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      />
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-picker-title"
      >
        <header className="modal-header">
          <h2 id="tool-picker-title">New operation</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="tool-picker">
          {TOOLS_WITH_FORMS.map((tool) => (
            <button
              type="button"
              key={tool.name}
              className="tool-pick"
              onClick={() => onPick(tool.name)}
            >
              <div className="tool-pick-label">{tool.label}</div>
              <div className="tool-pick-desc">{tool.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
