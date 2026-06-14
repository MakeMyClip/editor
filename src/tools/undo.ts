import { z } from 'zod';
import { mutateSession, overwriteSession, readSnapshot } from '../session/store.js';

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
    // Read+validate the snapshot OUTSIDE the mutation so a bad file fails fast
    // (a torn snapshot throws SessionCorruptError, not a raw parse error).
    // Restore via overwriteSession (NOT mutateSession): restore must succeed even
    // when the live session.json is the corrupt file being recovered from, so it
    // must not parse the live file first. `rev` still advances monotonically.
    const restored = await readSnapshot(input.snapshotLabel);
    const session = await overwriteSession(restored.entries);
    return { restoredFrom: input.snapshotLabel, entryCount: session.entries.length };
  }

  const { result: removed, session } = await mutateSession((s) => {
    const popped = s.entries.pop();
    if (!popped) {
      throw new Error('Session is empty — nothing to undo.');
    }
    return popped;
  });
  return { removedOpId: removed.id, entryCount: session.entries.length };
}
