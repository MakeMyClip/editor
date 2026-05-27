import { z } from 'zod';
import { probe } from '../ffmpeg/probe.js';
import { type MediaId, type MediaRef, makeMediaId } from '../timeline/schema.js';
import { resolveInput } from '../workspace.js';

export const IngestInput = z.object({
  path: z.string().min(1).describe('Path to the source video, audio, or image file.'),
});

export type IngestInputType = z.infer<typeof IngestInput>;

export interface IngestResult {
  mediaId: MediaId;
  ref: MediaRef;
}

export async function ingest(input: IngestInputType): Promise<IngestResult> {
  const resolvedPath = resolveInput(input.path);
  const probed = await probe(resolvedPath);

  return {
    mediaId: makeMediaId(resolvedPath),
    ref: {
      path: resolvedPath,
      durationSec: probed.durationSec,
      video: probed.video,
      audio: probed.audio,
    },
  };
}
