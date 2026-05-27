import { z } from 'zod';
import type { NamedPosition } from '../ffmpeg/args/add-text.js';
import { ensureWorkspace } from '../workspace.js';
import { addText } from './add-text.js';

const POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const satisfies readonly NamedPosition[];

const CueSchema = z
  .object({
    text: z.string().min(1).max(500),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    position: z.enum(POSITIONS).default('bottom-center'),
  })
  .refine((v) => v.endSec > v.startSec, {
    message: 'cue endSec must be > startSec',
    path: ['endSec'],
  });

export const AddCaptionsInput = z.object({
  input: z.string().min(1).describe('Source video.'),
  cues: z
    .array(CueSchema)
    .min(1)
    .describe(
      'Caption cues in display order. Each cue: { text, startSec, endSec, position? }. ' +
        'This tool does NOT transcribe — pass cues pre-computed (the agent can produce them ' +
        'from a transcript or write them by hand).',
    ),
});

export type AddCaptionsInputType = z.input<typeof AddCaptionsInput>;

export interface AddCaptionsResult {
  path: string;
  cueCount: number;
  durationMs: number;
}

export async function addCaptions(rawInput: AddCaptionsInputType): Promise<AddCaptionsResult> {
  const input = AddCaptionsInput.parse(rawInput);

  await ensureWorkspace();
  // Loop addText per cue, threading the previous output as the next input.
  // Each call is a re-encode (drawtext requires it), so for many cues this
  // is O(N) encodes — workable for typical caption density (~10-30 cues).
  const start = Date.now();
  let current: string = input.input;
  for (const cue of input.cues) {
    const result = await addText({
      input: current,
      text: cue.text,
      position: cue.position,
      startSec: cue.startSec,
      endSec: cue.endSec,
    });
    current = result.path;
  }
  return { path: current, cueCount: input.cues.length, durationMs: Date.now() - start };
}
