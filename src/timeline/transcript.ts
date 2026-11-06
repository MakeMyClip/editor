import { createHash, randomBytes } from 'node:crypto';
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
import { checkExportable, type MediaInfo, withoutTextOverlays } from './compile.js';
import { type Composition, findClip, type MediaClip, makeClipId } from './composition.js';
import { applyOp, type CompositionOp, type SourceRange } from './ops.js';
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

/** Thrown when a clip's source hasn't been transcribed yet. */
export class NoTranscriptError extends TranscriptError {
  constructor(message: string) {
    super(message);
    this.name = 'NoTranscriptError';
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
  /** Phrases said twice in a row; cut with `remove_retakes`. */
  retakes: Retake[];
  /** Identifies this transcript; edits by word index must send it back. */
  transcriptId: string;
}

/** A short hash of what a transcript says and how it was made: two different
 *  transcripts of the same file (another model or language) get different ids. */
export function transcriptIdOf(transcript: Transcript): string {
  const { modelKey, requestedLanguage, words } = transcript;
  return createHash('sha256')
    .update(JSON.stringify({ modelKey, requestedLanguage, words }))
    .digest('hex')
    .slice(0, 12);
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

  // Whisper is slow: a second caller asking for the same transcription while one
  // runs (the UI after a trim, a parallel agent call) waits for it instead.
  const runKey = `${storePath}|${modelKey}|${language}|${source.size}|${source.mtimeMs}`;
  const running = inFlight.get(runKey);
  if (running) return running;
  const run = (async (): Promise<Transcript> => {
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
  })();
  inFlight.set(runKey, run);
  try {
    return await run;
  } finally {
    inFlight.delete(runKey);
  }
}

/** Transcriptions running in this process, by store path and settings. */
const inFlight = new Map<string, Promise<Transcript>>();

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

/** A media clip and its source's transcript (transcribed if not cached). */
export async function transcriptForClip(
  comp: Composition,
  clipId: string,
  media: Map<MediaId, MediaInfo>,
  opts: TranscribeOptions = {},
): Promise<{ clip: MediaClip; transcript: Transcript }> {
  const { clip, info } = locateMediaClip(comp, clipId, media);
  return { clip, transcript: await transcribeMedia(clip.mediaId, info, opts) };
}

/**
 * A media clip and its source's STORED transcript, without transcribing: the
 * transcript whose word indices the caller was shown, whatever model or
 * language made it. Editing by those indices against any other transcript
 * could cut the wrong words, so this throws when there is none yet, when the
 * source file changed since, or when `expectedId` (the `transcriptId` the
 * caller was shown) no longer matches because it was transcribed again.
 */
export async function storedTranscriptForClip(
  comp: Composition,
  clipId: string,
  media: Map<MediaId, MediaInfo>,
  expectedId?: string,
): Promise<{ clip: MediaClip; transcript: Transcript }> {
  const { clip, info } = locateMediaClip(comp, clipId, media);
  const transcript = await readTranscript(transcriptPath(clip.mediaId));
  if (!transcript) {
    throw new NoTranscriptError(
      `Clip "${clipId}" has no transcript yet. Transcribe it first (\`clip timeline transcribe\` or timeline_transcript).`,
    );
  }
  if (expectedId !== undefined && transcriptIdOf(transcript) !== expectedId) {
    throw new TranscriptError(
      `Clip "${clipId}" was transcribed again since you read its words. Read the transcript again before cutting by word.`,
    );
  }
  const source = await stat(info.path);
  if (transcript.sourceSize !== source.size || transcript.sourceMtimeMs !== source.mtimeMs) {
    throw new TranscriptError(
      `Clip "${clipId}"'s source changed since it was transcribed. Transcribe it again first.`,
    );
  }
  return { clip, transcript };
}

function locateMediaClip(
  comp: Composition,
  clipId: string,
  media: Map<MediaId, MediaInfo>,
): { clip: MediaClip; info: MediaInfo } {
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
  return { clip, info };
}

/** Transcribe a media clip's source (cached) and return its words on the
 *  timeline, with any repeated takes found among them. */
export async function transcribeClip(
  comp: Composition,
  clipId: string,
  media: Map<MediaId, MediaInfo>,
  opts: TranscribeOptions = {},
): Promise<ClipTranscript> {
  const { clip, transcript } = await transcriptForClip(comp, clipId, media, opts);
  const words = clipWords(transcript, clip);
  return {
    clipId,
    mediaId: clip.mediaId,
    language: transcript.language,
    text: words.map((w) => w.text).join(' '),
    words,
    retakes: findRetakes(words),
    transcriptId: transcriptIdOf(transcript),
  };
}

/** An inclusive range of transcript word indices. */
export interface WordRange {
  fromIndex: number;
  toIndex: number;
}

/** A phrase said and then said again right away; `fromIndex..toIndex` is the
 *  earlier take, the one to cut. */
export interface Retake extends WordRange {
  text: string;
}

/** Longest phrase checked for an immediate repeat. */
const MAX_RETAKE_WORDS = 12;

function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Phrases of two or more words that are immediately said again ("I want to
 * show, I want to show you"), longest first. Single repeated words are left
 * alone: "very very" is often meant. The earlier take is the one reported,
 * because the later one is usually the take the speaker kept.
 */
export function findRetakes(words: ClipWord[]): Retake[] {
  const norm = words.map((w) => normalizeWord(w.text));
  const retakes: Retake[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = 0;
    for (let n = Math.min(MAX_RETAKE_WORDS, Math.floor((words.length - i) / 2)); n >= 2; n--) {
      let same = true;
      for (let k = 0; k < n && same; k++) {
        same = norm[i + k] !== '' && norm[i + k] === norm[i + n + k];
      }
      // A run of one word ("no no no") is emphasis, not a retake.
      if (same && new Set(norm.slice(i, i + n)).size > 1) {
        matched = n;
        break;
      }
    }
    const first = words[i];
    const last = words[i + matched - 1];
    if (matched > 0 && first && last) {
      retakes.push({
        fromIndex: first.index,
        toIndex: last.index,
        text: words
          .slice(i, i + matched)
          .map((w) => w.text)
          .join(' '),
      });
      i += matched;
    } else {
      i++;
    }
  }
  return retakes;
}

/** Kept slivers shorter than this between two cuts are cut too. */
const MIN_KEEP_SEC = 0.05;

/**
 * The `silenceCut` op that removes the given words from a media clip: each
 * range runs from its first word's start to its last word's end in source time,
 * clipped to the clip. Overlapping ranges merge, and the rest of the clip is
 * kept, so later clips ripple left and one undo restores everything. Null when
 * none of the words fall inside the clip; throws when they cover all of it, or
 * when the cut would stop an exportable timeline from exporting (a sub-clip
 * left shorter than a transition into or out of it).
 */
export function planWordCut(
  comp: Composition,
  clip: MediaClip,
  transcript: Transcript,
  ranges: WordRange[],
  opts: { media: Map<MediaId, MediaInfo>; mintId?: () => string },
): CompositionOp | null {
  const mintId = opts.mintId ?? makeClipId;
  const cuts = ranges
    .map((r) => {
      const from = transcript.words[r.fromIndex];
      const to = transcript.words[r.toIndex];
      if (!from || !to || r.toIndex < r.fromIndex) {
        throw new TranscriptError(
          `Words ${r.fromIndex}..${r.toIndex} aren't in the transcript of clip "${clip.id}".`,
        );
      }
      return {
        start: Math.max(clip.sourceInSec, from.startSec),
        end: Math.min(clip.sourceOutSec, to.endSec),
      };
    })
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  if (cuts.length === 0) return null;

  const keepRegions: SourceRange[] = [];
  let cursor = clip.sourceInSec;
  for (const cut of cuts) {
    if (cut.start - cursor >= MIN_KEEP_SEC) {
      keepRegions.push({ sourceInSec: cursor, sourceOutSec: cut.start });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (clip.sourceOutSec - cursor >= MIN_KEEP_SEC) {
    keepRegions.push({ sourceInSec: cursor, sourceOutSec: clip.sourceOutSec });
  }
  if (keepRegions.length === 0) {
    throw new TranscriptError(
      `Cutting those words would remove all of clip "${clip.id}"; remove the clip instead.`,
    );
  }
  const op: CompositionOp = {
    op: 'silenceCut',
    clipId: clip.id,
    keepRegions,
    newClipIds: keepRegions.slice(1).map(() => mintId()),
  };
  // The dir only names unwritten paths.
  if (checkExportable(withoutTextOverlays(comp), opts.media, '.').exportable) {
    const after = checkExportable(withoutTextOverlays(applyOp(comp, op)), opts.media, '.');
    if (!after.exportable) {
      throw new TranscriptError(
        `Cutting those words would stop the timeline from exporting: ${after.blockers.join(' ')} ` +
          'Cut fewer words next to the transition, or shorten or remove it.',
      );
    }
  }
  return op;
}
