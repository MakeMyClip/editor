import type { z } from 'zod';
import { AddAudioInput, addAudio } from '../tools/add-audio.js';
import { AddTextInput, addText } from '../tools/add-text.js';
import { AddTitleCardInput, addTitleCard } from '../tools/add-title-card.js';
import { AdjustInput, adjust } from '../tools/adjust.js';
import { ConcatInput, concat } from '../tools/concat.js';
import { IngestInput, ingest } from '../tools/ingest.js';
import { OverlayInput, overlay } from '../tools/overlay.js';
import { PreviewInput, preview } from '../tools/preview.js';
import { RenderInput, render } from '../tools/render.js';
import { SpeedInput, speed } from '../tools/speed.js';
import { SplitInput, split } from '../tools/split.js';
import { StabilizeInput, stabilize } from '../tools/stabilize.js';
import { TransitionInput, transition } from '../tools/transition.js';
import { TrimInput, trim } from '../tools/trim.js';
import { ZoomPanInput, zoomPan } from '../tools/zoom-pan.js';

/**
 * Maps tool name → { schema, fn }. The UI uses this to:
 *  - dispatch POST /api/tools/:name to the right function with Zod-validated input
 *  - render forms for the schemas (eventually; for now forms are hand-built)
 *
 * Composites with primitive-only inputs (add_title_card) are registered here
 * because their schemas form-render cleanly. Composites that take structured
 * inputs (add_captions cue arrays, highlight_reel segment arrays, silence_remove)
 * stay out until their forms are bespoke-built. Session-management tools
 * (snapshot/undo/inspect/delete) and the discriminated-union tool (transform)
 * are also excluded — they're meta-ops that don't fit the "submit a form,
 * get a new op" pattern.
 */
export const TOOL_REGISTRY: Record<
  string,
  {
    // biome-ignore lint/suspicious/noExplicitAny: each tool has a different schema; heterogeneous registry
    schema: z.ZodType<any>;
    // biome-ignore lint/suspicious/noExplicitAny: schema validates at runtime; downstream casts
    fn: (input: any) => Promise<unknown>;
  }
> = {
  ingest: { schema: IngestInput, fn: ingest },
  trim: { schema: TrimInput, fn: trim },
  split: { schema: SplitInput, fn: split },
  concat: { schema: ConcatInput, fn: concat },
  add_text: { schema: AddTextInput, fn: addText },
  add_audio: { schema: AddAudioInput, fn: addAudio },
  add_title_card: { schema: AddTitleCardInput, fn: addTitleCard },
  transition: { schema: TransitionInput, fn: transition },
  render: { schema: RenderInput, fn: render },
  preview: { schema: PreviewInput, fn: preview },
  adjust: { schema: AdjustInput, fn: adjust },
  speed: { schema: SpeedInput, fn: speed },
  overlay: { schema: OverlayInput, fn: overlay },
  zoom_pan: { schema: ZoomPanInput, fn: zoomPan },
  stabilize: { schema: StabilizeInput, fn: stabilize },
};

export function isRegisteredTool(name: string): name is keyof typeof TOOL_REGISTRY {
  return name in TOOL_REGISTRY;
}
