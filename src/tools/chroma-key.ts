import { z } from 'zod';
import { buildChromaKeyArgs } from '../ffmpeg/args/chroma-key.js';
import { probe } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const ChromaKeyInput = z.object({
  foreground: z
    .string()
    .min(1)
    .describe('Video with the color to remove (e.g. green-screen footage).'),
  background: z
    .string()
    .min(1)
    .describe('Background video OR still image (jpg, png) to composite over.'),
  color: z
    .string()
    .regex(/^(green|blue|red|cyan|magenta|yellow|black|white|#[0-9a-fA-F]{6}|0x[0-9a-fA-F]{6})$/)
    .default('green')
    .describe("Color to key out. Named colors, '#RRGGBB', or '0xRRGGBB'."),
  similarity: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe('How close a pixel must be to color to count. 0 = exact only, 1 = almost anything.'),
  blend: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe('Soft-edge amount. 0 = hard cut, 1 = very soft. 0.1 gives natural anti-aliasing.'),
  preferForegroundAudio: z
    .boolean()
    .default(false)
    .describe('If true, use audio from foreground; otherwise background. Default is background.'),
});

export type ChromaKeyInputType = z.input<typeof ChromaKeyInput>;

export interface ChromaKeyResult {
  path: string;
  durationMs: number;
  backgroundIsImage: boolean;
  audioSource: 'foreground' | 'background' | 'none';
}

export async function chromaKey(rawInput: ChromaKeyInputType): Promise<ChromaKeyResult> {
  const input = ChromaKeyInput.parse(rawInput);

  await ensureWorkspace();
  const resolvedFg = resolveInput(input.foreground);
  const resolvedBg = resolveInput(input.background);
  const output = newOutputPath('chroma-key', 'mp4');

  // Probe both to figure out audio routing + image-vs-video handling.
  // Images probe with durationSec=0 in our parser, so duration is the tell.
  const [probedBg, probedFg] = await Promise.all([probe(resolvedBg), probe(resolvedFg)]);

  if (!probedFg.video) {
    throw new Error(`chroma_key: foreground (${resolvedFg}) has no video stream.`);
  }
  if (!probedBg.video) {
    throw new Error(`chroma_key: background (${resolvedBg}) has no video stream.`);
  }

  // ffprobe shows still images with durationSec ≤ 0.04 (single frame at
  // most rates). Treat anything that short as an image — looping it for
  // the foreground duration matches user intent for static backgrounds.
  const backgroundIsImage = probedBg.durationSec < 0.5;
  const foregroundDurationSec = probedFg.durationSec;

  // Audio source selection: respect explicit preference if the chosen
  // source actually has audio; otherwise fall back to whichever side does.
  let takeForegroundAudio = input.preferForegroundAudio;
  let audioSource: 'foreground' | 'background' | 'none';
  if (takeForegroundAudio && probedFg.audio) {
    audioSource = 'foreground';
  } else if (!takeForegroundAudio && probedBg.audio) {
    audioSource = 'background';
  } else if (probedBg.audio) {
    takeForegroundAudio = false;
    audioSource = 'background';
  } else if (probedFg.audio) {
    takeForegroundAudio = true;
    audioSource = 'foreground';
  } else {
    audioSource = 'none';
  }

  const args = buildChromaKeyArgs({
    background: resolvedBg,
    foreground: resolvedFg,
    output,
    color: input.color,
    similarity: input.similarity,
    blend: input.blend,
    backgroundIsImage,
    foregroundDurationSec,
    takeForegroundAudio,
    hasAudio: audioSource !== 'none',
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, durationMs, backgroundIsImage, audioSource };
}
