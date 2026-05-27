import { z } from 'zod';
import { type AddAudioMode, buildAddAudioArgs } from '../ffmpeg/args/add-audio.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

const MODES = ['mix', 'replace'] as const satisfies readonly AddAudioMode[];

export const AddAudioInput = z.object({
  input: z
    .string()
    .min(1)
    .describe('Video file to add audio to. In mix mode, must already have an audio track.'),
  audio: z.string().min(1).describe('Audio (or video-with-audio) file to mix in or replace with.'),
  mode: z
    .enum(MODES)
    .default('mix')
    .describe('`mix` keeps base audio and overlays the new audio; `replace` drops base audio.'),
  audioVolume: z
    .number()
    .nonnegative()
    .max(2)
    .default(0.5)
    .describe(
      'Volume of the overlay audio. 0.5 is a good background-music default; 1.0 is unchanged.',
    ),
  startSec: z
    .number()
    .nonnegative()
    .default(0)
    .describe('When the overlay audio starts (seconds from the start of the video).'),
});

export type AddAudioInputType = z.input<typeof AddAudioInput>;

export interface AddAudioResult {
  path: string;
  mode: AddAudioMode;
  durationMs: number;
}

export async function addAudio(rawInput: AddAudioInputType): Promise<AddAudioResult> {
  const input = AddAudioInput.parse(rawInput);

  await ensureWorkspace();
  const resolvedInput = resolveInput(input.input);
  const resolvedAudio = resolveInput(input.audio);
  const output = newOutputPath('add-audio', 'mp4');

  const args = buildAddAudioArgs({
    input: resolvedInput,
    audio: resolvedAudio,
    output,
    mode: input.mode,
    audioVolume: input.audioVolume,
    startSec: input.startSec,
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, mode: input.mode, durationMs };
}
