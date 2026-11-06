import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { z } from 'zod';

/**
 * Local speech-to-text through whisper.cpp, run as a subprocess (args as an
 * array, like FFmpeg). Optional: the core never bundles or downloads whisper or
 * a model. Callers that need a transcript get a `TranscriptionUnavailableError`
 * saying how to set it up; everything else in the editor works without it.
 */

/** Points at the whisper.cpp CLI when it isn't `whisper-cli` on PATH. */
export const WHISPER_PATH_ENV = 'MAKEMYCLIP_WHISPER_PATH';
/** Points at a ggml model file, e.g. `ggml-base.en.bin`. */
export const WHISPER_MODEL_ENV = 'MAKEMYCLIP_WHISPER_MODEL';

const SETUP_HINT =
  'Install whisper.cpp (macOS: `brew install whisper-cpp`; others: https://github.com/ggml-org/whisper.cpp), ' +
  'download a model such as ggml-base.en.bin from https://huggingface.co/ggerganov/whisper.cpp, ' +
  `then set ${WHISPER_MODEL_ENV}=/path/to/model.bin (and ${WHISPER_PATH_ENV} if whisper-cli is not on PATH).`;

/** Thrown when transcription is asked for but whisper.cpp or its model isn't set up. */
export class TranscriptionUnavailableError extends Error {
  constructor(reason: string) {
    super(`${reason} Transcription is optional and needs a local whisper.cpp. ${SETUP_HINT}`);
    this.name = 'TranscriptionUnavailableError';
  }
}

/** A whisper.cpp language code ('en', 'de', …) or 'auto' to detect it. */
export const WhisperLanguageSchema = z
  .string()
  .regex(/^(auto|[a-z]{2,3})$/, "Language must be a code like 'en' or 'auto'.")
  .describe("Spoken language code, e.g. 'en'; 'auto' (the default) detects it.");

export interface WhisperSetup {
  binary: string;
  model: string;
}

/** Locate whisper.cpp and a model: an explicit model path, then the env vars. */
export function resolveWhisper(model?: string): WhisperSetup {
  const modelPath = model ?? process.env[WHISPER_MODEL_ENV];
  if (!modelPath) throw new TranscriptionUnavailableError('No whisper model is configured.');
  if (!existsSync(modelPath)) {
    throw new TranscriptionUnavailableError(`The whisper model ${modelPath} does not exist.`);
  }
  return { binary: process.env[WHISPER_PATH_ENV] ?? 'whisper-cli', model: modelPath };
}

export interface WhisperArgs {
  model: string;
  /** 16 kHz mono WAV. */
  input: string;
  /** Output path without extension; whisper.cpp writes `<outBase>.json`. */
  outBase: string;
  /** Spoken language code, or 'auto'. */
  language: string;
}

/** One segment per word (`-ml 1 -sow`), written as JSON, nothing else printed. */
export function buildWhisperArgs({ model, input, outBase, language }: WhisperArgs): string[] {
  return [
    '-m',
    model,
    '-f',
    input,
    '-l',
    language,
    '-ml',
    '1',
    '-sow',
    '-oj',
    '-of',
    outBase,
    '-np',
  ];
}

const WhisperJsonSchema = z.object({
  result: z.object({ language: z.string() }).optional(),
  transcription: z.array(
    z.object({
      offsets: z.object({ from: z.number(), to: z.number() }),
      text: z.string(),
    }),
  ),
});

export interface Word {
  text: string;
  /** Source seconds. */
  startSec: number;
  endSec: number;
}

/** Words from whisper.cpp's `-oj` output (offsets in ms); empty segments dropped. */
export function parseWhisperJson(json: unknown): { language: string | null; words: Word[] } {
  const parsed = WhisperJsonSchema.parse(json);
  const words = parsed.transcription
    .map((s) => ({
      text: s.text.trim(),
      startSec: s.offsets.from / 1000,
      endSec: s.offsets.to / 1000,
    }))
    .filter((w) => w.text.length > 0);
  return { language: parsed.result?.language ?? null, words };
}

/** Run whisper.cpp; a missing binary becomes `TranscriptionUnavailableError`. */
export async function runWhisper(binary: string, args: string[]): Promise<void> {
  try {
    await execa(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new TranscriptionUnavailableError(`whisper.cpp was not found at "${binary}".`);
    }
    throw err;
  }
}
