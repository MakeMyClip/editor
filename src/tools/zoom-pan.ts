import { z } from 'zod';
import { buildZoomPanArgs } from '../ffmpeg/args/zoom-pan.js';
import { probe } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const ZoomPanInput = z
  .object({
    input: z.string().min(1).describe('Source video.'),
    fromZoom: z
      .number()
      .positive()
      .default(1)
      .describe('Starting zoom. 1 = no zoom. >1 = zoomed in.'),
    toZoom: z.number().positive().default(1.5).describe('Ending zoom.'),
    centerX: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .describe('Horizontal center of the zoom in [0, 1] normalized coords.'),
    centerY: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .describe('Vertical center of the zoom in [0, 1] normalized coords.'),
  })
  .refine((v) => v.fromZoom !== v.toZoom, {
    message: 'zoom_pan requires fromZoom != toZoom (otherwise it is a static crop)',
    path: ['toZoom'],
  });

export type ZoomPanInputType = z.input<typeof ZoomPanInput>;

export interface ZoomPanResult {
  path: string;
  fromZoom: number;
  toZoom: number;
  durationMs: number;
}

export async function zoomPan(rawInput: ZoomPanInputType): Promise<ZoomPanResult> {
  const input = ZoomPanInput.parse(rawInput);

  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath('zoom-pan', 'mp4');

  // We need width, height, fps, and duration to build the zoompan filter —
  // probe is the only way to discover them without forcing the agent to pass
  // them in. If the input lacks a video stream, fail clearly.
  const probed = await probe(resolvedInput);
  if (!probed.video) {
    throw new Error(`zoom_pan needs a video stream; ${resolvedInput} has none.`);
  }

  const fps = probed.video.fps > 0 ? probed.video.fps : 30;
  const totalFrames = Math.max(1, Math.round(probed.durationSec * fps));

  const args = buildZoomPanArgs({
    input: resolvedInput,
    output,
    fromZoom: input.fromZoom,
    toZoom: input.toZoom,
    centerX: input.centerX,
    centerY: input.centerY,
    totalFrames,
    width: probed.video.width,
    height: probed.video.height,
    fps,
    hasAudio: probed.audio !== null,
  });

  const { durationMs } = await runFfmpeg(args);
  return {
    path: output,
    fromZoom: input.fromZoom,
    toZoom: input.toZoom,
    durationMs,
  };
}
