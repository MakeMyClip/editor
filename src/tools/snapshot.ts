import { z } from 'zod';
import { readSession, snapshotPath, writeSnapshot } from '../session/store.js';

export const SnapshotInput = z.object({
  label: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, {
      message: 'Label must be ASCII letters, digits, underscore, or hyphen',
    })
    .optional()
    .describe('Name for this snapshot. Defaults to snap-<N> where N = current op count.'),
});

export type SnapshotInputType = z.infer<typeof SnapshotInput>;

export interface SnapshotResult {
  label: string;
  path: string;
  entryCount: number;
}

export async function snapshot(input: SnapshotInputType = {}): Promise<SnapshotResult> {
  const session = await readSession();
  const label = input.label ?? `snap-${session.entries.length}`;
  await writeSnapshot(label, session);
  return { label, path: snapshotPath(label), entryCount: session.entries.length };
}
