import { z } from 'zod';
import { buildOverlayArgs, type OverlayPosition } from '../ffmpeg/args/overlay.js';
import { probe } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

const POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const satisfies readonly OverlayPosition[];

export const OverlayInput = z
  .object({
    input: z.string().min(1).describe('Base video.'),
    overlay: z.string().min(1).describe('Overlay video or image (PNG, JPEG, MP4, etc.).'),
    position: z
      .enum(POSITIONS)
      .default('top-right')
      .describe('Where to place the overlay within the base frame.'),
    scaleToWidth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional pixel width to scale the overlay to. Height auto-fits.'),
    startSec: z.number().nonnegative().default(0),
    endSec: z.number().positive().optional(),
  })
  .refine((v) => v.endSec === undefined || v.endSec > v.startSec, {
    message: 'endSec must be greater than startSec',
    path: ['endSec'],
  });

export type OverlayInputType = z.input<typeof OverlayInput>;

export interface OverlayResult {
  path: string;
  durationMs: number;
  hasBaseAudio: boolean;
}

export async function overlay(rawInput: OverlayInputType): Promise<OverlayResult> {
  const input = OverlayInput.parse(rawInput);

  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const resolvedOverlay = resolveInput(input.overlay);
  const output = newOutputPath('overlay', 'mp4');

  // We probe the base only — overlay's audio is intentionally ignored
  // (overlay is visual; if the user wants overlay audio mixed, use add_audio).
  const probed = await probe(resolvedInput);
  const hasBaseAudio = probed.audio !== null;

  const args = buildOverlayArgs({
    input: resolvedInput,
    overlay: resolvedOverlay,
    output,
    position: input.position,
    scaleToWidth: input.scaleToWidth,
    startSec: input.startSec,
    endSec: input.endSec,
    hasBaseAudio,
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, durationMs, hasBaseAudio };
}
