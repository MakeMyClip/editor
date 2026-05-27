import { z } from 'zod';
import { buildTransitionArgs, type TransitionKind } from '../ffmpeg/args/transition.js';
import { probe } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, newOutputPath, resolveInput } from '../workspace.js';

const TRANSITION_KINDS = [
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'circleopen',
  'circleclose',
] as const satisfies readonly TransitionKind[];

export const TransitionInput = z.object({
  inputA: z
    .string()
    .min(1)
    .describe('Path to the first clip. Transition starts in the last `durationSec` seconds.'),
  inputB: z.string().min(1).describe('Path to the second clip.'),
  kind: z
    .enum(TRANSITION_KINDS)
    .default('fade')
    .describe('Transition style. `fade` is the safest default.'),
  durationSec: z
    .number()
    .positive()
    .max(10)
    .default(1)
    .describe('How long the transition lasts (seconds). Capped at 10.'),
});

export type TransitionInputType = z.input<typeof TransitionInput>;

export interface TransitionResult {
  path: string;
  durationMs: number;
  /** Where in clip A the transition started — sanity-check for the agent. */
  offsetSec: number;
  hasAudio: boolean;
}

export async function transition(rawInput: TransitionInputType): Promise<TransitionResult> {
  const input = TransitionInput.parse(rawInput);

  await ensureWorkspace();
  const resolvedA = resolveInput(input.inputA);
  const resolvedB = resolveInput(input.inputB);
  const output = newOutputPath('transition', 'mp4');

  // Probe clip A so the agent doesn't have to know its duration to pick a
  // sensible offset. Also detect audio presence on both inputs so we can
  // wire (or skip) the acrossfade leg without the agent guessing.
  const [probeA, probeB] = await Promise.all([probe(resolvedA), probe(resolvedB)]);

  if (probeA.durationSec <= input.durationSec) {
    throw new Error(
      `Clip A is only ${probeA.durationSec}s — too short for a ${input.durationSec}s transition. ` +
        `Either pick a shorter transition or extend clip A.`,
    );
  }

  // Mismatched audio is surprising: silently dropping audio because one clip
  // lacks it would leave the agent puzzling over a soundless output. Fail
  // explicitly and tell the agent how to fix it (re-encode the silent clip
  // with a silent audio track, e.g. via `ffmpeg -i <silent> -f lavfi -i
  // anullsrc -c:v copy -c:a aac -shortest <silent-with-audio>`).
  const aHas = Boolean(probeA.audio);
  const bHas = Boolean(probeB.audio);
  if (aHas !== bHas) {
    throw new Error(
      `Mismatched audio: clip A ${aHas ? 'has' : 'has no'} audio, clip B ${bHas ? 'has' : 'has no'} audio. ` +
        'Add a silent track to whichever input lacks audio before transitioning.',
    );
  }

  const offsetSec = probeA.durationSec - input.durationSec;
  const hasAudio = aHas && bHas;

  const args = buildTransitionArgs({
    inputA: resolvedA,
    inputB: resolvedB,
    output,
    kind: input.kind,
    durationSec: input.durationSec,
    offsetSec,
    hasAudio,
  });

  const { durationMs } = await runFfmpeg(args);
  return { path: output, durationMs, offsetSec, hasAudio };
}
