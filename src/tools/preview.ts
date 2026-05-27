import { z } from 'zod';
import { buildPreviewFrameArgs } from '../ffmpeg/args/preview.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const PreviewInput = z.object({
  input: z.string().min(1).describe('Path to the source video.'),
  atSec: z
    .number()
    .nonnegative()
    .describe('Timecode (seconds from start) to extract the frame at.'),
});

export type PreviewInputType = z.infer<typeof PreviewInput>;

export interface PreviewResult {
  path: string;
  atSec: number;
  durationMs: number;
}

export async function preview(input: PreviewInputType): Promise<PreviewResult> {
  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath('preview', 'jpg');

  const args = buildPreviewFrameArgs({
    input: resolvedInput,
    output,
    atSec: input.atSec,
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, atSec: input.atSec, durationMs };
}
