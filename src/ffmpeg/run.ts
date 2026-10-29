import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';

// Resolution order: explicit override → bundled binary → system PATH.
// The override exists so legally-cautious users can point at an LGPL-only
// or system-managed FFmpeg; see the License section in the README.
const ffmpegPath = process.env.MAKEMYCLIP_FFMPEG_PATH ?? ffmpegStatic ?? 'ffmpeg';

export interface FfmpegResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runFfmpeg(args: string[]): Promise<FfmpegResult> {
  const start = Date.now();
  const { stdout, stderr } = await execa(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout, stderr, durationMs: Date.now() - start };
}

/** Thrown before a run when the resolved FFmpeg lacks a filter the edit needs. */
export class MissingFilterError extends Error {
  readonly filter: string;
  readonly ffmpegPath: string;

  constructor(filter: string, ffmpegPath: string, message: string) {
    super(message);
    this.name = 'MissingFilterError';
    this.filter = filter;
    this.ffmpegPath = ffmpegPath;
  }
}

/** Filter names from `ffmpeg -filters`; rows look like ` T.C drawtext  V->V  Draw text…`. */
export function parseFilterList(stdout: string): Set<string> {
  return new Set([...stdout.matchAll(/^ \S+ (\S+)\s+\S*->\S*\s/gm)].map((m) => m[1] as string));
}

let filterList: Promise<Set<string>> | undefined;

/** The resolved FFmpeg's filters, listed once per process. */
export function listFilters(): Promise<Set<string>> {
  filterList ??= runFfmpeg(['-hide_banner', '-filters']).then(
    ({ stdout }) => parseFilterList(stdout),
    (err: unknown) => {
      // A failed listing is retried on the next call, not cached for the
      // life of a long-running `clip ui` or `clip mcp` process.
      filterList = undefined;
      throw err;
    },
  );
  return filterList;
}

/**
 * Fail before rendering text when FFmpeg can't draw it. Since FFmpeg 6.1
 * drawtext needs libharfbuzz as well as libfreetype; the Linux binary
 * `ffmpeg-static` installs has no harfbuzz, so it has no drawtext and FFmpeg
 * itself would only say "No such filter".
 */
export async function requireDrawtext(): Promise<void> {
  if ((await listFilters()).has('drawtext')) return;
  throw new MissingFilterError(
    'drawtext',
    ffmpegPath,
    `The FFmpeg at ${ffmpegPath} has no drawtext filter (it needs libfreetype and libharfbuzz), ` +
      'so it cannot render text for add_text, add_captions, add_title_card or timeline text clips. ' +
      'Set MAKEMYCLIP_FFMPEG_PATH to an FFmpeg that lists drawtext in `ffmpeg -hide_banner -filters`. ' +
      'On Debian or Ubuntu: `sudo apt install ffmpeg`, then `export MAKEMYCLIP_FFMPEG_PATH=/usr/bin/ffmpeg` ' +
      '(for `clip mcp`, set it in the env of the MCP client config).',
  );
}
