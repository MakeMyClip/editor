import { unlink } from 'node:fs/promises';
import { z } from 'zod';
import { mutateSession } from '../session/store.js';

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

  const { result: removed, session } = await mutateSession((s) => {
    const idx = s.entries.findIndex((e) => e.id === input.id);
    if (idx === -1) {
      throw new Error(`No op with id ${input.id} in session log.`);
    }
    const [entry] = s.entries.splice(idx, 1);
    if (!entry) {
      throw new Error('Unexpected: splice returned no entry.');
    }
    return entry;
  });

  // Unlink AFTER the mutation commits — file I/O must stay out of the mutator,
  // which can re-run on a detected write race.
  let removedFile: string | null = null;
  if (input.removeFile && typeof removed.result.path === 'string') {
    removedFile = removed.result.path;
    await unlink(removedFile).catch(() => undefined);
  }

  return { removedOpId: removed.id, removedFile, entryCount: session.entries.length };
}
