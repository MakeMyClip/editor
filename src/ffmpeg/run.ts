import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';

export const FFMPEG_PATH_ENV = 'MAKEMYCLIP_FFMPEG_PATH';

export interface FfmpegResolution {
  path: string;
  /** `env`: MAKEMYCLIP_FFMPEG_PATH; `bundled`: ffmpeg-static; `system`: `ffmpeg` on PATH. */
  source: 'env' | 'bundled' | 'system';
}

/**
 * Resolution order: explicit override → bundled binary → system PATH. The
 * override exists so legally-cautious users can point at an LGPL-only or
 * system-managed FFmpeg; see the License section in the README.
 */
export function resolveFfmpeg(
  env: Record<string, string | undefined> = process.env,
  bundled: string | null = ffmpegStatic,
): FfmpegResolution {
  const override = env[FFMPEG_PATH_ENV];
  if (override !== undefined) return { path: override, source: 'env' };
  if (bundled !== null) return { path: bundled, source: 'bundled' };
  return { path: 'ffmpeg', source: 'system' };
}

const ffmpegPath = resolveFfmpeg().path;

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

/** The major version from `ffmpeg -version` ("ffmpeg version 6.0", "n7.0.2"),
 *  or null for a build that doesn't say (a git snapshot). */
export function parseFfmpegMajor(stdout: string): number | null {
  const match = /^ffmpeg version n?(\d+)\./m.exec(stdout);
  return match ? Number(match[1]) : null;
}

let graphOption: Promise<string> | undefined;

/**
 * The option that reads a filtergraph from a file: `-/filter_complex` since
 * FFmpeg 7 (which deprecates the old one), `-filter_complex_script` before. A
 * build that doesn't name its version (a git snapshot) gets the old option
 * while its help still lists it.
 */
export function filterGraphFileOption(): Promise<string> {
  graphOption ??= (async () => {
    const major = parseFfmpegMajor((await runFfmpeg(['-hide_banner', '-version'])).stdout);
    if (major !== null) return major < 7 ? '-filter_complex_script' : '-/filter_complex';
    const help = (await runFfmpeg(['-hide_banner', '-h', 'full'])).stdout;
    return help.includes('-filter_complex_script') ? '-filter_complex_script' : '-/filter_complex';
  })().catch((err: unknown) => {
    graphOption = undefined;
    throw err;
  });
  return graphOption;
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
