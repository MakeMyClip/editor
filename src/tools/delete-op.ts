import { unlink } from 'node:fs/promises';
import { z } from 'zod';
import { readSession, writeSession } from '../session/store.js';

export const DeleteOpInput = z.object({
  id: z
    .string()
    .regex(/^op_[a-f0-9]{8}$/)
    .describe('Op id from `inspect`. Format: op_<8 hex chars>.'),
  removeFile: z
    .boolean()
    .default(false)
    .describe('If true, also unlink the output file referenced by this op (where applicable).'),
});

export type DeleteOpInputType = z.input<typeof DeleteOpInput>;

export interface DeleteOpResult {
  removedOpId: string;
  removedFile: string | null;
  entryCount: number;
}

export async function deleteOp(rawInput: DeleteOpInputType): Promise<DeleteOpResult> {
  const input = DeleteOpInput.parse(rawInput);

  const session = await readSession();
  const idx = session.entries.findIndex((e) => e.id === input.id);
  if (idx === -1) {
    throw new Error(`No op with id ${input.id} in session log.`);
  }
  const [removed] = session.entries.splice(idx, 1);
  if (!removed) {
    throw new Error('Unexpected: splice returned no entry.');
  }
  await writeSession(session);

  let removedFile: string | null = null;
  if (input.removeFile && typeof removed.result.path === 'string') {
    removedFile = removed.result.path;
    await unlink(removedFile).catch(() => undefined);
  }

  return { removedOpId: removed.id, removedFile, entryCount: session.entries.length };
}
