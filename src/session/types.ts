import { z } from 'zod';

/**
 * One entry in the session log — the record of a single CLI tool invocation.
 * `args` and `result` are stored as opaque JSON so the engine doesn't need to
 * know about every tool's schema; tools that consume the session (snapshot,
 * undo, inspect, delete) treat them as data.
 */
export const SessionEntrySchema = z.object({
  id: z.string().regex(/^op_[a-f0-9]{8}$/),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  timestamp: z.iso.datetime(),
});

export const SessionSchema = z.object({
  version: z.literal(1),
  entries: z.array(SessionEntrySchema),
});

export type SessionEntry = z.infer<typeof SessionEntrySchema>;
export type Session = z.infer<typeof SessionSchema>;

export const EMPTY_SESSION: Session = { version: 1, entries: [] };
