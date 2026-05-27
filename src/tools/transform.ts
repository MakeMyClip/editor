import { z } from 'zod';
import {
  buildCropArgs,
  buildFlipArgs,
  buildRotateArgs,
  buildScaleArgs,
} from '../ffmpeg/args/transform.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

const CropOp = z.object({
  op: z.literal('crop'),
  input: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const RotateOp = z.object({
  op: z.literal('rotate'),
  input: z.string().min(1),
  degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
});

const FlipOp = z.object({
  op: z.literal('flip'),
  input: z.string().min(1),
  axis: z.enum(['horizontal', 'vertical']),
});

const ScaleOp = z
  .object({
    op: z.literal('scale'),
    input: z.string().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .refine((v) => v.width !== undefined || v.height !== undefined, {
    message: 'scale requires at least one of width or height',
    path: ['width'],
  });

export const TransformInput = z.discriminatedUnion('op', [CropOp, RotateOp, FlipOp, ScaleOp]);

export type TransformInputType = z.infer<typeof TransformInput>;

export interface TransformResult {
  path: string;
  op: TransformInputType['op'];
  durationMs: number;
}

export async function transform(input: TransformInputType): Promise<TransformResult> {
  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath(`transform-${input.op}`, 'mp4');

  const args =
    input.op === 'crop'
      ? buildCropArgs({
          input: resolvedInput,
          output,
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
        })
      : input.op === 'rotate'
        ? buildRotateArgs({ input: resolvedInput, output, degrees: input.degrees })
        : input.op === 'flip'
          ? buildFlipArgs({ input: resolvedInput, output, axis: input.axis })
          : buildScaleArgs({
              input: resolvedInput,
              output,
              width: input.width,
              height: input.height,
            });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, op: input.op, durationMs };
}
