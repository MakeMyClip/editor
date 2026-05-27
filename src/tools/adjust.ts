import { z } from 'zod';
import { buildAdjustArgs } from '../ffmpeg/args/adjust.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const AdjustInput = z
  .object({
    input: z.string().min(1).describe('Source video.'),
    brightness: z
      .number()
      .min(-1)
      .max(1)
      .optional()
      .describe('-1 (black) to 1 (white). 0 is no change.'),
    contrast: z.number().min(0).max(4).optional().describe('0 to 4. 1 is no change.'),
    saturation: z
      .number()
      .min(0)
      .max(3)
      .optional()
      .describe('0 (grayscale) to 3 (vivid). 1 is no change.'),
    volume: z.number().min(0).max(2).optional().describe('0 (mute) to 2 (double). 1 is no change.'),
  })
  .refine(
    (v) =>
      v.brightness !== undefined ||
      v.contrast !== undefined ||
      v.saturation !== undefined ||
      v.volume !== undefined,
    {
      message: 'At least one adjustment (brightness, contrast, saturation, or volume) must be set.',
      path: ['brightness'],
    },
  );

export type AdjustInputType = z.infer<typeof AdjustInput>;

export interface AdjustResult {
  path: string;
  durationMs: number;
}

export async function adjust(input: AdjustInputType): Promise<AdjustResult> {
  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath('adjust', 'mp4');

  const args = buildAdjustArgs({
    input: resolvedInput,
    output,
    brightness: input.brightness,
    contrast: input.contrast,
    saturation: input.saturation,
    volume: input.volume,
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, durationMs };
}
