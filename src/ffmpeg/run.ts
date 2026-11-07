import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';
import { envSetting, findSystemBinary, isExecutable, type SystemLookup } from '../system-binary.js';

export const FFMPEG_PATH_ENV = 'MAKEMYCLIP_FFMPEG_PATH';

export interface FfmpegResolution {
  path: string;
  /** `env`: MAKEMYCLIP_FFMPEG_PATH; `bundled`: ffmpeg-static; `system`: an installed `ffmpeg`. */
  source: 'env' | 'bundled' | 'system';
}

export interface FfmpegLookup extends SystemLookup {
  /** ffmpeg-static's binary path; null on a platform it has no build for. */
  bundled?: string | null;
}

/**
 * Resolution order: explicit override → bundled binary → an installed FFmpeg.
 * The override exists so legally-cautious users can point at an LGPL-only or
 * system-managed FFmpeg; see the License section in the README. The bundled
 * binary is skipped when it isn't on disk: ffmpeg-static downloads it in an
 * install script, which `--ignore-scripts` skips and the Claude Desktop
 * extension leaves out on purpose.
 */
export function resolveFfmpeg(lookup: FfmpegLookup = {}): FfmpegResolution {
  const override = envSetting(FFMPEG_PATH_ENV, lookup.env);
  if (override !== undefined) return { path: override, source: 'env' };
  const bundled = lookup.bundled !== undefined ? lookup.bundled : ffmpegStatic;
  if (bundled !== null && (lookup.isExecutable ?? isExecutable)(bundled)) {
    return { path: bundled, source: 'bundled' };
  }
  return { path: findSystemBinary('ffmpeg', lookup), source: 'system' };
}

export interface FfmpegResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runFfmpeg(args: string[]): Promise<FfmpegResult> {
  // Resolved per run, so an FFmpeg installed while `clip mcp` or `clip ui`
  // runs is picked up without a restart.
  return runFfmpegAt(resolveFfmpeg().path, args);
}

async function runFfmpegAt(path: string, args: string[]): Promise<FfmpegResult> {
  const start = Date.now();
  const { stdout, stderr } = await execa(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout, stderr, durationMs: Date.now() - start };
}

/**
 * Memoize a per-binary answer, keyed by the FFmpeg it came from, so a newly
 * resolved FFmpeg is asked again. A failure is retried on the next call, not
 * cached for the life of a long-running `clip ui` or `clip mcp` process.
 */
function perBinary<T>(ask: (path: string) => Promise<T>): () => Promise<T> {
  const answers = new Map<string, Promise<T>>();
  return () => {
    const path = resolveFfmpeg().path;
    let answer = answers.get(path);
    if (!answer) {
      answer = ask(path).catch((err: unknown) => {
        answers.delete(path);
        throw err;
      });
      answers.set(path, answer);
    }
    return answer;
  };
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

/** The resolved FFmpeg's filters, listed once per binary. */
export const listFilters: () => Promise<Set<string>> = perBinary(async (path) =>
  parseFilterList((await runFfmpegAt(path, ['-hide_banner', '-filters'])).stdout),
);

/** The major version from `ffmpeg -version` ("ffmpeg version 6.0", "n7.0.2"),
 *  or null for a build that doesn't say (a git snapshot). */
export function parseFfmpegMajor(stdout: string): number | null {
  const match = /^ffmpeg version n?(\d+)\./m.exec(stdout);
  return match ? Number(match[1]) : null;
}

/**
 * The option that reads a filtergraph from a file: `-/filter_complex` since
 * FFmpeg 7 (which deprecates the old one), `-filter_complex_script` before. A
 * build that doesn't name its version (a git snapshot) gets the old option
 * while its help still lists it.
 */
export const filterGraphFileOption: () => Promise<string> = perBinary(async (path) => {
  const major = parseFfmpegMajor((await runFfmpegAt(path, ['-hide_banner', '-version'])).stdout);
  if (major !== null) return major < 7 ? '-filter_complex_script' : '-/filter_complex';
  const help = (await runFfmpegAt(path, ['-hide_banner', '-h', 'full'])).stdout;
  return help.includes('-filter_complex_script') ? '-filter_complex_script' : '-/filter_complex';
});

/**
 * Fail before rendering text when FFmpeg can't draw it. Since FFmpeg 6.1
 * drawtext needs libharfbuzz as well as libfreetype; the Linux binary
 * `ffmpeg-static` installs has no harfbuzz, so it has no drawtext and FFmpeg
 * itself would only say "No such filter".
 */
export async function requireDrawtext(): Promise<void> {
  if ((await listFilters()).has('drawtext')) return;
  const ffmpegPath = resolveFfmpeg().path;
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
