import type { z } from 'zod';
import { AddAudioInput, addAudio } from '../tools/add-audio.js';
import { AddCaptionsInput, addCaptions } from '../tools/add-captions.js';
import { AddTextInput, addText } from '../tools/add-text.js';
import { AddTitleCardInput, addTitleCard } from '../tools/add-title-card.js';
import { AdjustInput, adjust } from '../tools/adjust.js';
import { ChromaKeyInput, chromaKey } from '../tools/chroma-key.js';
import { ConcatInput, concat } from '../tools/concat.js';
import { HighlightReelInput, highlightReel } from '../tools/highlight-reel.js';
import { IngestInput, ingest } from '../tools/ingest.js';
import { OverlayInput, overlay } from '../tools/overlay.js';
import { PreviewInput, preview } from '../tools/preview.js';
import { RenderInput, render } from '../tools/render.js';
import { SilenceRemoveInput, silenceRemove } from '../tools/silence-remove.js';
import { SpeedInput, speed } from '../tools/speed.js';
import { SplitInput, split } from '../tools/split.js';
import { StabilizeInput, stabilize } from '../tools/stabilize.js';
import { TransitionInput, transition } from '../tools/transition.js';
import { TrimInput, trim } from '../tools/trim.js';
import { ZoomPanInput, zoomPan } from '../tools/zoom-pan.js';
import { resolveInWorkspace } from '../workspace.js';

interface ToolEntry {
  // biome-ignore lint/suspicious/noExplicitAny: each tool has a different schema; heterogeneous registry
  schema: z.ZodType<any>;
  // biome-ignore lint/suspicious/noExplicitAny: schema validates at runtime; downstream casts
  fn: (input: any) => Promise<unknown>;
  /**
   * Input fields that carry a source file path (a string, or a string[] of
   * paths). At the untrusted agent/UI boundary these are confined to the
   * workspace before the handler runs — see `confineToolInput`. A handler whose
   * inputs are all in-document/in-workspace by construction omits this.
   */
  pathFields?: readonly string[];
}

/**
 * Confine an untrusted tool input's source-path fields to the workspace.
 *
 * Both agent/UI dispatch surfaces — `POST /api/tools/:name` (unauthenticated
 * localhost) and the chat agent's legacy tool calls — feed model/HTTP-supplied
 * paths straight into FFmpeg, which reads whatever the OS will open. Without
 * this, pointing any path-bearing tool (`render`, `trim`, `overlay`, …) at a
 * file outside the workspace is an arbitrary-file read — and, since the result
 * is re-encoded into a workspace file the UI serves back, an exfiltration
 * channel. So every such field is routed through `resolveInWorkspace`, which
 * throws `WorkspaceBoundaryError` on escape (AGENTS.md non-negotiable #3). The
 * trusted CLI never dispatches through here — a user-typed path is consent.
 *
 * Only the listed fields are touched; the rest of the input passes through
 * untouched. A wrong/absent field name would silently leave a path unconfined,
 * so `pathFields` is kept in lockstep with each handler's `resolveInput` calls.
 */
function confineToolInput(input: unknown, pathFields: readonly string[]): unknown {
  if (input === null || typeof input !== 'object') return input;
  const confined: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const field of pathFields) {
    const value = confined[field];
    if (typeof value === 'string') {
      confined[field] = resolveInWorkspace(value);
    } else if (Array.isArray(value)) {
      confined[field] = value.map((item) =>
        typeof item === 'string' ? resolveInWorkspace(item) : item,
      );
    }
  }
  return confined;
}

/**
 * Raw tool definitions. `pathFields` declares which inputs are source paths;
 * the workspace-confining wrapper is applied below when building TOOL_REGISTRY.
 */
const RAW_TOOLS: Record<string, ToolEntry> = {
  ingest: { schema: IngestInput, fn: ingest, pathFields: ['path'] },
  trim: { schema: TrimInput, fn: trim, pathFields: ['input'] },
  split: { schema: SplitInput, fn: split, pathFields: ['input'] },
  concat: { schema: ConcatInput, fn: concat, pathFields: ['inputs'] },
  add_text: { schema: AddTextInput, fn: addText, pathFields: ['input'] },
  add_audio: { schema: AddAudioInput, fn: addAudio, pathFields: ['input', 'audio'] },
  add_title_card: { schema: AddTitleCardInput, fn: addTitleCard, pathFields: ['input'] },
  transition: { schema: TransitionInput, fn: transition, pathFields: ['inputA', 'inputB'] },
  render: { schema: RenderInput, fn: render, pathFields: ['input'] },
  preview: { schema: PreviewInput, fn: preview, pathFields: ['input'] },
  adjust: { schema: AdjustInput, fn: adjust, pathFields: ['input'] },
  speed: { schema: SpeedInput, fn: speed, pathFields: ['input'] },
  overlay: { schema: OverlayInput, fn: overlay, pathFields: ['input', 'overlay'] },
  zoom_pan: { schema: ZoomPanInput, fn: zoomPan, pathFields: ['input'] },
  stabilize: { schema: StabilizeInput, fn: stabilize, pathFields: ['input'] },
  chroma_key: { schema: ChromaKeyInput, fn: chromaKey, pathFields: ['foreground', 'background'] },
  silence_remove: { schema: SilenceRemoveInput, fn: silenceRemove, pathFields: ['input'] },
  highlight_reel: { schema: HighlightReelInput, fn: highlightReel, pathFields: ['input'] },
  add_captions: { schema: AddCaptionsInput, fn: addCaptions, pathFields: ['input'] },
};

function wrapWithConfinement(entry: ToolEntry): ToolEntry {
  const { schema, fn, pathFields } = entry;
  if (!pathFields) return { schema, fn };
  // async so a synchronous WorkspaceBoundaryError surfaces as a rejected promise
  // (the dispatch sites await entry.fn and turn rejections into 403 / error-data).
  return { schema, fn: async (input: unknown) => fn(confineToolInput(input, pathFields)) };
}

/**
 * Maps tool name → { schema, fn }. The UI uses this to:
 *  - dispatch POST /api/tools/:name to the right function with Zod-validated input
 *  - render forms for the schemas (eventually; for now forms are hand-built)
 *
 * Every entry's path inputs are confined to the workspace (see `confineToolInput`)
 * so the agent/UI tool surface cannot read files outside the sandbox; only the
 * trusted CLI, which never dispatches through here, stays unconfined.
 *
 * Composites (add_title_card, add_captions, highlight_reel, silence_remove,
 * chroma_key) are registered here once the UI has a hand-built form for
 * their schema — including the row-list pattern for structured-input
 * composites (add_captions cues, highlight_reel segments). Session-
 * management tools (snapshot/undo/inspect/delete) and the discriminated-
 * union tool (transform) stay excluded — they're meta-ops that don't fit
 * the "submit a form, get a new op" pattern.
 */
export const TOOL_REGISTRY: Record<
  string,
  {
    // biome-ignore lint/suspicious/noExplicitAny: each tool has a different schema; heterogeneous registry
    schema: z.ZodType<any>;
    // biome-ignore lint/suspicious/noExplicitAny: schema validates at runtime; downstream casts
    fn: (input: any) => Promise<unknown>;
  }
> = Object.fromEntries(
  Object.entries(RAW_TOOLS).map(([name, entry]) => [name, wrapWithConfinement(entry)] as const),
);

export function isRegisteredTool(name: string): name is keyof typeof TOOL_REGISTRY {
  return name in TOOL_REGISTRY;
}
