import { z } from 'zod';
import { ensureWorkspace } from '../workspace.js';
import { concat } from './concat.js';
import { transition } from './transition.js';
import { trim } from './trim.js';

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
] as const;

const SegmentSchema = z
  .object({
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
  })
  .refine((v) => v.endSec > v.startSec, {
    message: 'segment endSec must be > startSec',
    path: ['endSec'],
  });

export const HighlightReelInput = z.object({
  input: z.string().min(1).describe('Long-form source video.'),
  segments: z
    .array(SegmentSchema)
    .min(2)
    .describe('Two or more time ranges to extract and stitch in order.'),
  transitionKind: z
    .enum(TRANSITION_KINDS)
    .optional()
    .describe(
      'Optional transition between segments. Omit for hard cuts (faster, stream-copy concat).',
    ),
  transitionSec: z.number().positive().max(5).default(0.5),
});

export type HighlightReelInputType = z.input<typeof HighlightReelInput>;

export interface HighlightReelResult {
  path: string;
  segmentCount: number;
  transitionCount: number;
  durationMs: number;
}

export async function highlightReel(
  rawInput: HighlightReelInputType,
): Promise<HighlightReelResult> {
  const input = HighlightReelInput.parse(rawInput);

  await ensureWorkspace();
  const start = Date.now();

  // Step 1: trim each segment in parallel (stream-copy, fast).
  const trimmed = await Promise.all(
    input.segments.map((seg) =>
      trim({
        input: input.input,
        start: String(seg.startSec),
        end: String(seg.endSec),
      }),
    ),
  );

  // Step 2a: hard cut path — just concat-demuxer everything together.
  if (!input.transitionKind) {
    const result = await concat({ inputs: trimmed.map((t) => t.path) });
    return {
      path: result.path,
      segmentCount: trimmed.length,
      transitionCount: 0,
      durationMs: Date.now() - start,
    };
  }

  // Step 2b: with transitions — pairwise reduce. N segments → N-1 transitions.
  // Each transition re-encodes, so the accumulator drifts from stream-copy to
  // a single re-encoded result by the end. Sequential (not parallel) because
  // each step depends on the previous step's output.
  let current = trimmed[0]?.path;
  if (!current) {
    throw new Error('Unexpected: parallel trim returned no segments.');
  }
  for (let i = 1; i < trimmed.length; i++) {
    const next = trimmed[i];
    if (!next) continue;
    const result = await transition({
      inputA: current,
      inputB: next.path,
      kind: input.transitionKind,
      durationSec: input.transitionSec,
    });
    current = result.path;
  }

  return {
    path: current,
    segmentCount: trimmed.length,
    transitionCount: trimmed.length - 1,
    durationMs: Date.now() - start,
  };
}
