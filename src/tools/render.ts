import { z } from 'zod';
import { buildRenderArgs, type RenderFormat, type RenderPreset } from '../ffmpeg/args/render.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

const FORMATS = ['mp4', 'mov', 'webm'] as const satisfies readonly RenderFormat[];
const PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const satisfies readonly RenderPreset[];

export const RenderInput = z.object({
  input: z.string().min(1).describe('Source video path.'),
  format: z.enum(FORMATS).default('mp4').describe('Container + codec family.'),
  crf: z
    .number()
    .int()
    .min(0)
    .max(51)
    .default(23)
    .describe('Quality (libx264/libvpx-vp9 CRF). Lower = better. 23 is a good default.'),
  preset: z
    .enum(PRESETS)
    .default('medium')
    .describe('libx264 speed/efficiency tradeoff. Ignored for webm.'),
  maxWidth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional max width in pixels. Preserves aspect; never upscales.'),
});

export type RenderInputType = z.input<typeof RenderInput>;

export interface RenderResult {
  path: string;
  format: RenderFormat;
  durationMs: number;
}

export async function render(rawInput: RenderInputType): Promise<RenderResult> {
  const input = RenderInput.parse(rawInput);

  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath('render', input.format);

  const args = buildRenderArgs({
    input: resolvedInput,
    output,
    format: input.format,
    crf: input.crf,
    preset: input.preset,
    maxWidth: input.maxWidth,
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, format: input.format, durationMs };
}
