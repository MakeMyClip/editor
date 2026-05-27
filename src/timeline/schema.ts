import { z } from 'zod';

export const TimecodeSchema = z.string().regex(/^\d{1,2}:\d{2}:\d{2}(\.\d+)?$|^\d+(\.\d+)?$/, {
  message: 'Timecode must be HH:MM:SS[.ms] or seconds (e.g. "00:01:23.5" or "83.5")',
});

export const ClipSchema = z.object({
  source: z.string().min(1),
  start: TimecodeSchema,
  end: TimecodeSchema,
});

export const TimelineSchema = z.object({
  version: z.literal(1),
  clips: z.array(ClipSchema).min(1),
});

export type Timecode = z.infer<typeof TimecodeSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
