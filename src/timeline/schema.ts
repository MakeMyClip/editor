import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TimecodeSchema = z.string().regex(/^\d{1,2}:\d{2}:\d{2}(\.\d+)?$|^\d+(\.\d+)?$/, {
  message: 'Timecode must be HH:MM:SS[.ms] or seconds (e.g. "00:01:23.5" or "83.5")',
});

export const MediaIdSchema = z.string().regex(/^m_[a-f0-9]{12}$/, {
  message: 'MediaId must be of the form m_<12 hex chars>',
});

/** The timeline every workspace starts with, kept at `composition.json`. */
export const MAIN_TIMELINE = 'main';

/** A named timeline in the workspace: `main`, or a short such as `best-1`. */
export const TimelineIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, {
    message:
      'A timeline id is 1–48 lowercase letters, digits or hyphens, starting with a letter or digit (e.g. "best-1").',
  })
  .describe(
    'Timeline to work on (default "main"). A short made with make_short is a timeline of its own.',
  );

export const VideoStreamSchema = z.object({
  codec: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().nonnegative(),
});

export const AudioStreamSchema = z.object({
  codec: z.string(),
  sampleRate: z.number().int().nonnegative(),
  channels: z.string(),
});

export const MediaRefSchema = z.object({
  path: z.string().min(1),
  durationSec: z.number().nonnegative(),
  video: VideoStreamSchema.nullable(),
  audio: AudioStreamSchema.nullable(),
});

export type Timecode = z.infer<typeof TimecodeSchema>;
export type MediaId = z.infer<typeof MediaIdSchema>;
export type VideoStream = z.infer<typeof VideoStreamSchema>;
export type AudioStream = z.infer<typeof AudioStreamSchema>;
export type MediaRef = z.infer<typeof MediaRefSchema>;

/**
 * Deterministic mediaId derived from the absolute media path.
 *
 * Same path → same id, across runs and across machines. This makes ingest
 * idempotent: re-ingesting the same file returns the same id, so tools that
 * accept mediaIds in the future can safely re-key without callers tracking
 * registrations themselves.
 */
export function makeMediaId(absolutePath: string): MediaId {
  const hash = createHash('sha1').update(absolutePath).digest('hex').slice(0, 12);
  return `m_${hash}` as MediaId;
}
