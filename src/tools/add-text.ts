import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { buildAddTextArgs, type NamedPosition } from '../ffmpeg/args/add-text.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, getWorkspace, newOutputPath, resolveInput } from '../workspace.js';

const NAMED_POSITIONS = [
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

export const AddTextInput = z
  .object({
    input: z.string().min(1).describe('Path to the source video (absolute or relative to cwd).'),
    text: z.string().min(1).max(500).describe('The text to overlay. Literal newlines are honored.'),
    position: z
      .enum(NAMED_POSITIONS)
      .default('bottom-center')
      .describe('Where to place the text within the frame.'),
    startSec: z.number().nonnegative().describe('When the text appears (seconds from start).'),
    endSec: z.number().nonnegative().describe('When the text disappears (seconds from start).'),
    fontSize: z.number().int().min(8).max(300).default(48),
    color: z
      .string()
      .min(1)
      .default('white')
      .describe('Text color: CSS name (e.g. "white"), "#RRGGBB", or "0xRRGGBB[@alpha]".'),
    box: z
      .boolean()
      .default(true)
      .describe('Draw a translucent background box behind the text for readability.'),
  })
  .refine((v) => v.endSec > v.startSec, {
    message: 'endSec must be greater than startSec',
    path: ['endSec'],
  });

/**
 * Pre-parse input type — `fontSize`, `color`, `box`, and `position` are
 * optional because the Zod schema applies defaults. Callers pass what they
 * have; `addText` parses internally so defaults land consistently.
 */
export type AddTextInputType = z.input<typeof AddTextInput>;

export interface AddTextResult {
  path: string;
  durationMs: number;
}

export async function addText(rawInput: AddTextInputType): Promise<AddTextResult> {
  const input = AddTextInput.parse(rawInput);

  await ensureWorkspace();
  const workspace = getWorkspace();
  const resolvedInput = resolveInput(input.input);
  const output = newOutputPath('add-text', 'mp4');

  // Route text through a tempfile so drawtext never sees user-controlled text
  // inline in the filter graph. Sidesteps the most painful class of FFmpeg
  // footguns (colon/quote/comma/percent escaping inside drawtext's `text=`).
  const textfileId = randomBytes(4).toString('hex');
  const textfile = resolve(workspace, `add-text-${textfileId}.txt`);
  await writeFile(textfile, input.text, 'utf8');

  try {
    const args = buildAddTextArgs({
      input: resolvedInput,
      output,
      textfile,
      position: input.position,
      startSec: input.startSec,
      endSec: input.endSec,
      fontSize: input.fontSize,
      color: input.color,
      box: input.box,
    });
    const { durationMs } = await runFfmpeg(args);
    return { path: output, durationMs };
  } finally {
    // Best-effort cleanup; if ffmpeg already failed there's nothing else to do.
    await unlink(textfile).catch(() => undefined);
  }
}
