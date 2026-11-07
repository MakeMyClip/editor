import { writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { probeTimecode } from '../ffmpeg/probe.js';
import type { Composition } from './composition.js';
import { writeFcpxml } from './interchange-fcpxml.js';
import { buildLayout, type InterchangeMedia } from './interchange-layout.js';
import { writeXmeml } from './interchange-xmeml.js';
import type { MediaId, MediaRef } from './schema.js';

export { InterchangeError, type InterchangeMedia } from './interchange-layout.js';

/**
 * Export the timeline as a file an editor opens:
 *  - `fcpxml` — FCPXML 1.10, for Final Cut Pro and DaVinci Resolve.
 *  - `xmeml` — Final Cut Pro 7 XML, for Premiere Pro (and Resolve), with text as
 *    SRT captions beside it, since Premiere drops this format's text generators.
 * Media is referenced by absolute file URL, not copied. Whatever the file can't
 * hold is refused with an `InterchangeError` naming the fix; what it holds only
 * in part (text styling, say) comes back in `notes`.
 */
export const InterchangeFormatSchema = z
  .enum(['fcpxml', 'xmeml'])
  .describe(
    'fcpxml: Final Cut Pro and DaVinci Resolve. xmeml: Final Cut Pro 7 XML for Premiere Pro (Resolve reads it too); text goes to .srt caption files beside it.',
  );
export type InterchangeFormat = z.infer<typeof InterchangeFormatSchema>;

const EXTENSION: Record<InterchangeFormat, string> = { fcpxml: 'fcpxml', xmeml: 'xml' };

/** File extension (no dot) an interchange format is written with. */
export function interchangeExtension(format: InterchangeFormat): string {
  return EXTENSION[format];
}

/** The interchange format a path's extension names, or null (e.g. `.mp4`). */
export function interchangeFormatFor(path: string): InterchangeFormat | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.fcpxml') return 'fcpxml';
  if (ext === '.xml') return 'xmeml';
  return null;
}

export interface InterchangeFile {
  path: string;
  content: string;
}

export interface InterchangeExport {
  format: InterchangeFormat;
  /** The main file first, then any caption sidecars. */
  files: InterchangeFile[];
  /** Length of the exported sequence, in seconds (the mp4 export's length). */
  durationSec: number;
  /** What the file carries only in part, for the user to finish in the editor. */
  notes: string[];
}

/** Lay `comp` out and write it as `format` (pure: no files touched). Sidecar
 *  paths sit beside `output`. */
export function buildInterchange(
  comp: Composition,
  media: Map<MediaId, InterchangeMedia>,
  options: { format: InterchangeFormat; output: string },
): InterchangeExport {
  const layout = buildLayout(comp, media);
  const name = basename(options.output, extname(options.output));
  const durationSec = (layout.duration * layout.rate.num) / layout.rate.den;
  if (options.format === 'fcpxml') {
    const { content, notes } = writeFcpxml(layout, name);
    return { format: 'fcpxml', files: [{ path: options.output, content }], durationSec, notes };
  }
  const { content, captions, notes } = writeXmeml(layout, name);
  const dir = dirname(options.output);
  const sidecars = captions.map(({ trackId, srt }) => ({
    path: join(dir, captions.length === 1 ? `${name}.srt` : `${name}.${trackId}.srt`),
    content: srt,
  }));
  return {
    format: 'xmeml',
    files: [{ path: options.output, content }, ...sidecars],
    durationSec,
    notes,
  };
}

/**
 * Read the start timecode of each source the timeline uses (editors match media
 * by it), build the export and write its files.
 */
export async function exportInterchange(
  comp: Composition,
  refs: Map<MediaId, MediaRef>,
  options: { format: InterchangeFormat; output: string },
): Promise<InterchangeExport> {
  const used = new Set<MediaId>();
  for (const track of comp.tracks) {
    for (const clip of track.clips) if (clip.kind === 'media') used.add(clip.mediaId);
  }
  const media = new Map<MediaId, InterchangeMedia>();
  for (const id of used) {
    const ref = refs.get(id);
    if (!ref) continue;
    media.set(id, { ...ref, timecode: ref.video ? await probeTimecode(ref.path) : null });
  }
  const result = buildInterchange(comp, media, options);
  for (const file of result.files) await writeFile(file.path, file.content);
  return result;
}
