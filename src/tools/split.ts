import { z } from 'zod';
import { buildSplitArgs } from '../ffmpeg/args/split.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const SplitInput = z.object({
  input: z.string().min(1).describe('Path to the source video.'),
  atSec: z
    .number()
    .positive()
    .describe('Where to split (seconds). Must be > 0 and within the clip duration.'),
});

export type SplitInputType = z.infer<typeof SplitInput>;

export interface SplitResult {
  before: string;
  after: string;
  atSec: number;
  durationMs: number;
}

export async function split(input: SplitInputType): Promise<SplitResult> {
  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const beforeOutput = newOutputPath('split-before', 'mp4');
  const afterOutput = newOutputPath('split-after', 'mp4');

  const [beforeArgs, afterArgs] = buildSplitArgs(
    resolvedInput,
    input.atSec,
    beforeOutput,
    afterOutput,
  );

  // Both halves are stream-copy and independent — run them in parallel so the
  // tool latency is max(beforeMs, afterMs) rather than the sum.
  const start = Date.now();
  await Promise.all([runFfmpeg(beforeArgs), runFfmpeg(afterArgs)]);
  const durationMs = Date.now() - start;

  return { before: beforeOutput, after: afterOutput, atSec: input.atSec, durationMs };
}
