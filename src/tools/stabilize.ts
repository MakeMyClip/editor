import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { buildVidstabDetectArgs, buildVidstabTransformArgs } from '../ffmpeg/args/stabilize.js';
import { probe } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, getWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const StabilizeInput = z.object({
  input: z.string().min(1).describe('Source video with shaky footage.'),
  shakiness: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('How shaky the input is. Higher = look for bigger movements. 5 is a good default.'),
  smoothing: z
    .number()
    .int()
    .min(0)
    .max(40)
    .default(10)
    .describe(
      'Frames over which to smooth the camera path. Higher = smoother but more delay between input and stabilized output.',
    ),
  accuracy: z
    .number()
    .int()
    .min(1)
    .max(15)
    .default(15)
    .describe(
      'Motion-detection accuracy (1..15). Default 15. Lower values can produce transforms files that this build of vidstab fails to parse — bump back up if you hit "Cannot parse localmotion".',
    ),
  zoom: z
    .number()
    .min(0)
    .max(20)
    .default(5)
    .describe(
      'Percent zoom-in to hide warp borders. 5% is usually enough; bump higher for very shaky inputs.',
    ),
});

export type StabilizeInputType = z.input<typeof StabilizeInput>;

export interface StabilizeResult {
  path: string;
  durationMs: number;
}

export async function stabilize(rawInput: StabilizeInputType): Promise<StabilizeResult> {
  const input = StabilizeInput.parse(rawInput);

  await ensureWorkspace();
  const workspace = getWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath('stabilize', 'mp4');

  // The transforms file is the bridge between the two passes. It lives in
  // the workspace and gets cleaned up after the transform pass completes.
  const trfId = randomBytes(4).toString('hex');
  const transformsFile = resolve(workspace, `stabilize-${trfId}.trf`);

  const probed = await probe(resolvedInput);
  const hasAudio = probed.audio !== null;

  const start = Date.now();
  try {
    await runFfmpeg(
      buildVidstabDetectArgs({
        input: resolvedInput,
        transformsFile,
        shakiness: input.shakiness,
        accuracy: input.accuracy,
      }),
    );
    await runFfmpeg(
      buildVidstabTransformArgs({
        input: resolvedInput,
        output,
        transformsFile,
        smoothing: input.smoothing,
        zoom: input.zoom,
        hasAudio,
      }),
    );
    return { path: output, durationMs: Date.now() - start };
  } finally {
    await unlink(transformsFile).catch(() => undefined);
  }
}
