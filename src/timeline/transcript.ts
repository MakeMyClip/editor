import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { buildSpeechAudioArgs } from '../ffmpeg/args/speech-audio.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { atomicWriteFile } from '../session/store.js';
import {
  buildWhisperArgs,
  parseWhisperJson,
  resolveWhisper,
  runWhisper,
  WhisperLanguageSchema,
} from '../transcribe/whisper.js';
import { getWorkspace, resolveInWorkspace } from '../workspace.js';
import type { MediaInfo } from './compile.js';
import { type Composition, findClip, type MediaClip } from './composition.js';
import { type MediaId, MediaIdSchema } from './schema.js';

/**
 * Transcripts of source media, one per media id, kept beside the document
 * rather than in it so the document stays a clean render input. Words carry
 * source times; `clipWords` places them on the timeline for a clip. Made by a
 * local whisper.cpp, which is optional (see `transcribe/whisper.ts`).
 */

const TranscriptWordSchema = z.object({
  text: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
});

export const TranscriptSchema = z.object({
  version: z.literal(1),
  mediaId: MediaIdSchema,
  language: z.string().nullable(),
  source: z.literal('whisper-cpp'),
  /** Model file name, for people reading the transcript. */
  model: z.string(),
  /** The model's resolved path, size and mtime; any other model transcribes again. */
  modelKey: z.string(),
  /** The language asked for ('auto' or a code); a different request transcribes again. */
  requestedLanguage: z.string(),
  /** The source file's size and mtime when transcribed; an edited file transcribes again. */
  sourceSize: z.number(),
  sourceMtimeMs: z.number(),
  words: z.array(TranscriptWordSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** Thrown when a clip can't be transcribed (not media, no audio, not registered). */
export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptError';
  }
}

export interface TranscribeOptions {
  /** Model file; defaults to `MAKEMYCLIP_WHISPER_MODEL`. */
  model?: string;
  /** Spoken language code; default 'auto' (detect). */
  language?: string;
}

/** A transcript word inside a clip, in timeline seconds. `index` is the word's
 *  position in the source transcript, stable across clips of the same media. */
export interface ClipWord {
  index: number;
  text: string;
  startSec: number;
  endSec: number;
}

export interface ClipTranscript {
  clipId: string;
  mediaId: MediaId;
  language: string | null;
  text: string;
  words: ClipWord[];
}

/** Where a media file's transcript is kept, checked against the workspace (the
 *  `transcripts` folder could be a symlink out of it). */
export function transcriptPath(mediaId: MediaId): string {
  return resolveInWorkspace(join('transcripts', `${mediaId}.json`));
}

/** A stored transcript, or null when there is none or it can't be read (the
 *  caller then transcribes again, so a damaged file costs time, not data). */
async function readTranscript(path: string): Promise<Transcript | null> {
  try {
    return TranscriptSchema.parse(JSON.parse(await readFile(path, 'utf-8')));
  } catch {
    return null;
  }
}

function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

/**
 * Transcribe one source file with the local whisper.cpp, reusing the stored
 * transcript while the file, model and language still match. Throws
 * `TranscriptionUnavailableError` when whisper.cpp or a model isn't set up.
 */
export async function transcribeMedia(
  mediaId: MediaId,
  info: MediaInfo,
  opts: TranscribeOptions = {},
): Promise<Transcript> {
  if (!info.hasAudio) throw new TranscriptError(`Media "${mediaId}" has no audio to transcribe.`);
  const setup = resolveWhisper(opts.model);
  const language = WhisperLanguageSchema.parse(opts.language ?? 'auto');
  const source = await stat(info.path);
  const modelStat = await stat(setup.model);
  const modelKey = `${resolve(setup.model)}:${modelStat.size}:${modelStat.mtimeMs}`;
  const storePath = transcriptPath(mediaId);

  const cached = await readTranscript(storePath);
  if (
    cached &&
    cached.modelKey === modelKey &&
    cached.requestedLanguage === language &&
    cached.sourceSize === source.size &&
    cached.sourceMtimeMs === source.mtimeMs
  ) {
    return cached;
  }

  const dir = join(getWorkspace(), `.transcribe-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    const wav = join(dir, 'speech.wav');
    const outBase = join(dir, 'speech');
    await runFfmpeg(buildSpeechAudioArgs({ input: info.path, output: wav }));
    await runWhisper(
      setup.binary,
      buildWhisperArgs({ model: setup.model, input: wav, outBase, language }),
    );
    const parsed = parseWhisperJson(JSON.parse(await readFile(`${outBase}.json`, 'utf-8')));
    const transcript: Transcript = {
      version: 1,
      mediaId,
      language: parsed.language ?? (language === 'auto' ? null : language),
      source: 'whisper-cpp',
      model: basename(setup.model),
      modelKey,
      requestedLanguage: language,
      sourceSize: source.size,
      sourceMtimeMs: source.mtimeMs,
      words: parsed.words,
    };
    await atomicWriteFile(storePath, `${JSON.stringify(transcript, null, 2)}\n`);
    return transcript;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The transcript's words that fall inside a clip's source window, placed on
 *  the timeline; a word straddling an edge is clipped to it. */
export function clipWords(transcript: Transcript, clip: MediaClip): ClipWord[] {
  const toTimeline = (sec: number): number => roundMs(clip.startSec + sec - clip.sourceInSec);
  return transcript.words.flatMap((w, index) => {
    if (w.endSec <= clip.sourceInSec || w.startSec >= clip.sourceOutSec) return [];
    return [
      {
        index,
        text: w.text,
        startSec: toTimeline(Math.max(w.startSec, clip.sourceInSec)),
        endSec: toTimeline(Math.min(w.endSec, clip.sourceOutSec)),
      },
    ];
  });
}

/** Transcribe a media clip's source (cached) and return its words on the timeline. */
export async function transcribeClip(
  comp: Composition,
  clipId: string,
  media: Map<MediaId, MediaInfo>,
  opts: TranscribeOptions = {},
): Promise<ClipTranscript> {
  const found = findClip(comp, clipId);
  if (!found) {
    throw new TranscriptError(
      `No clip "${clipId}" in the timeline. Run \`clip timeline show\` to list clip ids.`,
    );
  }
  const { clip } = found;
  if (clip.kind !== 'media') {
    throw new TranscriptError(
      `Clip "${clipId}" is a ${clip.kind} clip; only media clips have speech.`,
    );
  }
  const info = media.get(clip.mediaId);
  if (!info)
    throw new TranscriptError(`No media registered for "${clip.mediaId}" (clip "${clipId}").`);
  const transcript = await transcribeMedia(clip.mediaId, info, opts);
  const words = clipWords(transcript, clip);
  return {
    clipId,
    mediaId: clip.mediaId,
    language: transcript.language,
    text: words.map((w) => w.text).join(' '),
    words,
  };
}
