import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { quoteFilterArg } from '../ffmpeg/escape.js';
import { probe } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ensureWorkspace, getWorkspace, newOutputPath, resolveInput } from '../workspace.js';
import { concat } from './concat.js';

export const AddTitleCardInput = z.object({
  input: z.string().min(1).describe('Base video to prepend the title card to.'),
  text: z.string().min(1).max(120),
  durationSec: z.number().positive().max(15).default(2),
  background: z
    .string()
    .regex(/^(black|white|#[0-9a-fA-F]{6}|0x[0-9a-fA-F]{6})$/)
    .default('black')
    .describe("CSS color name (black/white), '#RRGGBB', or '0xRRGGBB'."),
  fontSize: z.number().int().min(12).max(300).default(72),
  fontColor: z.string().default('white'),
});

export type AddTitleCardInputType = z.input<typeof AddTitleCardInput>;

export interface AddTitleCardResult {
  path: string;
  durationMs: number;
}

export async function addTitleCard(rawInput: AddTitleCardInputType): Promise<AddTitleCardResult> {
  const input = AddTitleCardInput.parse(rawInput);

  await ensureWorkspace();
  const workspace = getWorkspace();
  const resolvedInput = resolveInput(input.input);

  // Probe to match card dimensions / fps / audio sample rate so concat can
  // stream-copy without re-encoding the base video.
  const probed = await probe(resolvedInput);
  if (!probed.video) {
    throw new Error(`add_title_card needs a video stream; ${resolvedInput} has none.`);
  }
  const { width, height, fps } = probed.video;
  const sampleRate = probed.audio?.sampleRate ?? 48000;
  const wantsAudio = probed.audio !== null;

  // Text file for drawtext — same pattern as add_text. User text never enters
  // the filter graph directly.
  const textfileId = randomBytes(4).toString('hex');
  const textfile = resolve(workspace, `title-card-${textfileId}.txt`);
  await writeFile(textfile, input.text, 'utf-8');

  const cardOutput = newOutputPath('title-card-render', 'mp4');
  const drawFilter =
    `drawtext=textfile=${quoteFilterArg(textfile)}` +
    `:fontsize=${input.fontSize}` +
    `:fontcolor=${quoteFilterArg(input.fontColor)}` +
    `:x=(w-text_w)/2:y=(h-text_h)/2`;

  const start = Date.now();
  try {
    const cardArgs = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${input.background}:s=${width}x${height}:d=${input.durationSec}:r=${fps}`,
    ];
    if (wantsAudio) {
      cardArgs.push(
        '-f',
        'lavfi',
        '-i',
        `anullsrc=cl=stereo:r=${sampleRate}:d=${input.durationSec}`,
      );
    }
    cardArgs.push(
      '-vf',
      drawFilter,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
    );
    if (wantsAudio) {
      cardArgs.push('-c:a', 'aac', '-shortest');
    }
    cardArgs.push(cardOutput);
    await runFfmpeg(cardArgs);

    // Render the base through libx264+aac too so concat-demuxer can stream-
    // copy both halves. (Skipping this is a common cause of concat-mismatch
    // errors when the source has different codecs/params.)
    const normalizedBase = newOutputPath('title-card-base', 'mp4');
    const baseArgs = ['-y', '-i', resolvedInput];
    baseArgs.push(
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
    );
    if (wantsAudio) {
      baseArgs.push('-c:a', 'aac', '-ar', String(sampleRate));
    }
    baseArgs.push(normalizedBase);
    await runFfmpeg(baseArgs);

    const result = await concat({ inputs: [cardOutput, normalizedBase] });
    return { path: result.path, durationMs: Date.now() - start };
  } finally {
    await unlink(textfile).catch(() => undefined);
  }
}
