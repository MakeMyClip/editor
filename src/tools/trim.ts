import { z } from 'zod';
import { buildTrimArgs } from '../ffmpeg/args/trim.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { TimecodeSchema } from '../timeline/schema.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const TrimInput = z.object({
  input: z.string().min(1).describe('Path to the source video (absolute or relative to cwd).'),
  start: TimecodeSchema.describe('Start timecode (HH:MM:SS[.ms] or seconds).'),
  end: TimecodeSchema.describe('End timecode (HH:MM:SS[.ms] or seconds).'),
});

export type TrimInputType = z.infer<typeof TrimInput>;

export interface TrimResult {
  path: string;
  durationMs: number;
}

export async function trim(input: TrimInputType): Promise<TrimResult> {
  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath('trim', 'mp4');

  const args = buildTrimArgs({
    input: resolvedInput,
    start: input.start,
    end: input.end,
    output,
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, durationMs };
}
