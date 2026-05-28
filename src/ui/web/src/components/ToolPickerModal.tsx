interface ToolMeta {
  name: string;
  label: string;
  description: string;
}

interface ToolGroup {
  label: string;
  tools: ToolMeta[];
}

// Tools the UI has hand-built forms for. Grouped because we're past the
// flat-list-readable threshold. Add to these lists as new forms ship.
const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'Cut & arrange',
    tools: [
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
        name: 'transition',
        label: 'Transition',
        description: 'Crossfade, slide, or fade between two clips.',
      },
    ],
  },
  {
    label: 'Text & captions',
    tools: [
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
        name: 'add_captions',
        label: 'Add captions',
        description: 'Burn multiple timed caption cues onto a video.',
      },
    ],
  },
  {
    label: 'Composites',
    tools: [
      {
        name: 'highlight_reel',
        label: 'Highlight reel',
        description: 'Extract several time ranges and stitch them with optional transitions.',
      },
      {
        name: 'silence_remove',
        label: 'Remove silence',
        description: 'Detect and cut silent stretches from a video with audio.',
      },
      {
        name: 'chroma_key',
        label: 'Chroma key',
        description: 'Key out a color from the foreground and composite over a background.',
      },
    ],
  },
  {
    label: 'Output',
    tools: [
      {
        name: 'render',
        label: 'Render',
        description: 'Re-encode to a specific format / quality / size.',
      },
    ],
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
          {TOOL_GROUPS.map((group) => (
            <div className="tool-pick-group" key={group.label}>
              <div className="tool-pick-group-label">{group.label}</div>
              {group.tools.map((tool) => (
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
          ))}
        </div>
      </div>
    </div>
  );
}
