import { z } from 'zod';
import { buildSpeedArgs } from '../ffmpeg/args/speed.js';
import { probe } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const SpeedInput = z
  .object({
    input: z.string().min(1).describe('Source video.'),
    factor: z
      .number()
      .positive()
      .default(1)
      .describe('Speed multiplier. 2 = double, 0.5 = half (slow-mo).'),
    reverse: z.boolean().default(false).describe('Play backwards.'),
  })
  .refine((v) => v.factor !== 1 || v.reverse, {
    message: 'speed requires factor !== 1 or reverse=true (otherwise it is a no-op)',
    path: ['factor'],
  });

export type SpeedInputType = z.input<typeof SpeedInput>;

export interface SpeedResult {
  path: string;
  factor: number;
  reverse: boolean;
  hasAudio: boolean;
  durationMs: number;
}

export async function speed(rawInput: SpeedInputType): Promise<SpeedResult> {
  const input = SpeedInput.parse(rawInput);

  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath('speed', 'mp4');

  // Probe to know whether to wire an audio leg in the filter graph. Without
  // this we'd error on video-only inputs (filter graph references [0:a]
  // which wouldn't exist).
  const probed = await probe(resolvedInput);
  const hasAudio = probed.audio !== null;

  const args = buildSpeedArgs({
    input: resolvedInput,
    output,
    factor: input.factor,
    reverse: input.reverse,
    hasAudio,
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, factor: input.factor, reverse: input.reverse, hasAudio, durationMs };
}
