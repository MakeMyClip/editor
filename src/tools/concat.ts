import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { buildConcatArgs } from '../ffmpeg/args/concat.js';
import { quoteFilterArg } from '../ffmpeg/escape.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, getWorkspace, newOutputPath, resolveInput } from '../workspace.js';

export const ConcatInput = z.object({
  inputs: z
    .array(z.string().min(1))
    .min(2)
    .describe('Paths to two or more media files. Concatenated in order.'),
});

export type ConcatInputType = z.infer<typeof ConcatInput>;

export interface ConcatResult {
  path: string;
  durationMs: number;
  inputCount: number;
}

/**
 * Build the line content for a concat-demuxer list file. Exported for
 * testing — the format is precise (one `file '<quoted-path>'` per line,
 * trailing newline) and small mistakes show up only at ffmpeg-runtime.
 */
export function buildConcatListContent(absolutePaths: string[]): string {
  return `${absolutePaths.map((path) => `file ${quoteFilterArg(path)}`).join('\n')}\n`;
}

export async function concat(input: ConcatInputType): Promise<ConcatResult> {
  await ensureWorkspace();
  const workspace = getWorkspace();
  const resolvedInputs = input.inputs.map(resolveInput);
  const output = newOutputPath('concat', 'mp4');

  // The concat demuxer reads its list from a file path on disk. We write
  // one ephemeral list per invocation; it lives only long enough for ffmpeg
  // to read it, then we clean up regardless of success or failure.
  const listId = randomBytes(4).toString('hex');
  const listFile = resolve(workspace, `concat-${listId}.txt`);
  await writeFile(listFile, buildConcatListContent(resolvedInputs), 'utf8');

  try {
    const args = buildConcatArgs({ listFile, output });
    const { durationMs } = await runFfmpeg(args);
    return { path: output, durationMs, inputCount: resolvedInputs.length };
  } finally {
    await unlink(listFile).catch(() => undefined);
  }
}
