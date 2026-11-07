import { writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { probeTimecode } from '../ffmpeg/probe.js';
import type { Composition } from './composition.js';
import { writeFcpxml } from './interchange-fcpxml.js';
import { buildLayout, type InterchangeMedia, type Layout } from './interchange-layout.js';
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
  const written =
    options.format === 'fcpxml'
      ? { ...writeFcpxml(layout, name), captions: [] }
      : writeXmeml(layout, name);
  const notes = [...written.notes, ...letterboxNote(layout)];
  const dir = dirname(options.output);
  // Track ids are free text: keep only filename-safe characters, and never
  // reuse a name — the main file's included (case-blind, as macOS is).
  const taken = new Set([options.output.toLowerCase()]);
  const sidecars = written.captions.map(({ trackId, srt }) => {
    const safe = trackId.replace(/[^A-Za-z0-9_-]+/g, '_') || 'text';
    const stem = written.captions.length > 1 ? `${name}.${safe}` : name;
    let path = join(dir, `${stem}.srt`);
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = join(dir, `${stem}-${n}.srt`);
    taken.add(path.toLowerCase());
    return { path, content: srt };
  });
  return {
    format: options.format,
    files: [{ path: options.output, content: written.content }, ...sidecars],
    durationSec,
    notes,
  };
}

/** The mp4 export pads a clip of another shape with the timeline background;
 *  editors letterbox it in black. Say so when that changes the picture. */
function letterboxNote(layout: Layout): string[] {
  const { r, g, b } = layout.background;
  if (r + g + b === 0) return [];
  const canvas = layout.width / layout.height;
  const letterboxed = [...layout.media.values()].some(
    (info) => info.video && Math.abs(info.video.width / info.video.height - canvas) > 1e-3,
  );
  return letterboxed
    ? [
        "Clips of another shape than the canvas show black bars in the editor; the timeline's background color behind them isn't carried.",
      ]
    : [];
}

/**
 * Read the start timecode of each source the timeline uses (editors match media
 * by it), build the export and write its files. `confine` vets every path
 * written, caption sidecars included — untrusted surfaces pass
 * `resolveInWorkspace`.
 */
export async function exportInterchange(
  comp: Composition,
  refs: Map<MediaId, MediaRef>,
  options: { format: InterchangeFormat; output: string; confine?: (path: string) => string },
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
  const built = buildInterchange(comp, media, options);
  const confine = options.confine ?? ((path: string) => path);
  const files = built.files.map((file) => ({ ...file, path: confine(file.path) }));
  for (const file of files) await writeFile(file.path, file.content);
  return { ...built, files };
}
