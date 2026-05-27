import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { readSession, snapshotPath, writeSession } from '../session/store.js';
import { SessionSchema } from '../session/types.js';

export const UndoInput = z.object({
  snapshotLabel: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional snapshot to restore from. Omit to pop just the last op off the session log.',
    ),
});

export type UndoInputType = z.infer<typeof UndoInput>;

export interface UndoResult {
  removedOpId?: string;
  restoredFrom?: string;
  entryCount: number;
}

export async function undo(input: UndoInputType = {}): Promise<UndoResult> {
  if (input.snapshotLabel) {
    const raw = await readFile(snapshotPath(input.snapshotLabel), 'utf-8');
    const restored = SessionSchema.parse(JSON.parse(raw));
    await writeSession(restored);
    return { restoredFrom: input.snapshotLabel, entryCount: restored.entries.length };
  }

  const session = await readSession();
  const removed = session.entries.pop();
  if (!removed) {
    throw new Error('Session is empty — nothing to undo.');
  }
  await writeSession(session);
  return { removedOpId: removed.id, entryCount: session.entries.length };
}
