import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';
import { z } from 'zod';
import { fontFileFor } from '../ffmpeg/font.js';
import { FFMPEG_PATH_ENV, parseFilterList, resolveFfmpeg } from '../ffmpeg/run.js';
import { isFile } from '../system-binary.js';
import { WHISPER_MODEL_ENV, WHISPER_PATH_ENV, whisperBinary } from '../transcribe/whisper.js';
import { getWorkspace } from '../workspace.js';

/**
 * Check that this machine has what the editor needs, and say how to fix what
 * it doesn't. Reads only local state: it runs the resolved FFmpeg and
 * whisper.cpp, looks at files, and writes one temporary file in the workspace.
 */

export const DoctorInput = z.object({});

export type DoctorInputType = z.infer<typeof DoctorInput>;

/** `fail`: the editor can't run. `warn`: a feature is off. `skip`: not checked
 *  because a check it depends on failed. */
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export type DoctorCheckId =
  | 'node'
  | 'ffmpeg'
  | 'drawtext'
  | 'vidstab'
  | 'workspace'
  | 'font'
  | 'whisper'
  | 'whisper-model';

export interface DoctorCheck {
  id: DoctorCheckId;
  label: string;
  status: DoctorStatus;
  /** What was found. */
  detail: string;
  /** What to do, for a `warn` or `fail`. */
  fix?: string;
}

export interface DoctorResult {
  /** False when any check failed. Warnings leave it true. */
  ok: boolean;
  checks: DoctorCheck[];
  /** Where the MAKEMYCLIP_* settings named in the fixes are changed. */
  howToSet: string;
}

/** What the checks read from the machine; tests pass stubs. */
export interface DoctorDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** `process.versions.node`, e.g. "24.1.0". */
  nodeVersion: string;
  /** ffmpeg-static's binary path; null on a platform it has no build for. */
  bundledFfmpeg: string | null;
  workspace: string;
  /** Run a binary to completion. Rejects like execa: `code` 'ENOENT' when it
   *  isn't found; `exitCode`, `stdout` and `stderr` set when it exited non-zero. */
  run(file: string, args: string[]): Promise<{ stdout: string }>;
  isFile(path: string): boolean;
  /** Create the folder if needed, then write and remove a file in it. */
  probeWritable(dir: string): Promise<void>;
  /** The font file captions draw Latin text with; undefined means FFmpeg's default. */
  captionFont(): string | undefined;
}

/** package.json `engines.node`. */
const MIN_NODE_MAJOR = 24;
const WORKSPACE_ENV = 'MAKEMYCLIP_WORKSPACE';
const FALLBACK_FONT_ENV = 'MAKEMYCLIP_FALLBACK_FONT';
/** Set to `mcpb` by the Claude Desktop extension's manifest. */
const BUNDLE_ENV = 'MAKEMYCLIP_BUNDLE';

export function defaultDoctorDeps(): DoctorDeps {
  return {
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    bundledFfmpeg: ffmpegStatic,
    workspace: getWorkspace(),
    run: async (file, args) => {
      const { stdout } = await execa(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
      });
      return { stdout };
    },
    isFile,
    probeWritable: async (dir) => {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.doctor-${randomBytes(4).toString('hex')}`);
      await writeFile(probe, '');
      await unlink(probe);
    },
    captionFont: () => fontFileFor('Aa', { always: true }),
  };
}

export async function doctor(
  _input: DoctorInputType = {},
  deps: DoctorDeps = defaultDoctorDeps(),
): Promise<DoctorResult> {
  const { check: ffmpeg, filters } = await checkFfmpeg(deps);
  const checks = [
    checkNode(deps.nodeVersion),
    ffmpeg,
    checkDrawtext(filters),
    checkVidstab(filters),
    await checkWorkspace(deps),
    checkFont(deps),
    await checkWhisper(deps),
    checkWhisperModel(deps),
  ];
  return {
    ok: checks.every((c) => c.status !== 'fail'),
    checks,
    howToSet: inExtension(deps)
      ? "Change these in Claude Desktop, in the MakeMyClip Editor extension's settings: Media folder is MAKEMYCLIP_WORKSPACE, FFmpeg is MAKEMYCLIP_FFMPEG_PATH, Whisper model is MAKEMYCLIP_WHISPER_MODEL and whisper-cli is MAKEMYCLIP_WHISPER_PATH."
      : 'Set environment variables in your shell profile; for `clip mcp`, set them in the MCP client config for the server.',
  };
}

function inExtension(deps: DoctorDeps): boolean {
  return deps.env[BUNDLE_ENV] === 'mcpb';
}

function checkNode(version: string): DoctorCheck {
  const major = Number(version.split('.')[0]);
  const base = { id: 'node', label: 'Node.js' } as const;
  if (major >= MIN_NODE_MAJOR) return { ...base, status: 'ok', detail: version };
  return {
    ...base,
    status: 'fail',
    detail: `${version} is too old; the editor needs Node ${MIN_NODE_MAJOR} or newer.`,
    fix: `Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org or with a version manager (nvm, fnm), then run this again.`,
  };
}

const SOURCE_NAMES = {
  env: FFMPEG_PATH_ENV,
  bundled: 'bundled ffmpeg-static',
  system: 'system',
} as const;

function installFfmpegHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '`brew install ffmpeg`';
  if (platform === 'win32') return '`winget install Gyan.FFmpeg`';
  return 'on Debian or Ubuntu, `sudo apt install ffmpeg`';
}

async function checkFfmpeg(
  deps: DoctorDeps,
): Promise<{ check: DoctorCheck; filters: Set<string> | null }> {
  const { path, source } = resolveFfmpeg({
    env: deps.env,
    platform: deps.platform,
    isFile: deps.isFile,
    bundled: deps.bundledFfmpeg,
  });
  const base = { id: 'ffmpeg', label: 'FFmpeg' } as const;
  try {
    const { stdout } = await deps.run(path, ['-hide_banner', '-version']);
    const version = /^ffmpeg version (\S+)/m.exec(stdout)?.[1] ?? 'unknown version';
    const filters = parseFilterList((await deps.run(path, ['-hide_banner', '-filters'])).stdout);
    return {
      check: { ...base, status: 'ok', detail: `${version} (${SOURCE_NAMES[source]}) ${path}` },
      filters,
    };
  } catch (err) {
    const install = installFfmpegHint(deps.platform);
    let fix: string;
    const found = `It is found on PATH and in Homebrew's, MacPorts' and winget's folders; or set ${FFMPEG_PATH_ENV} to its path.`;
    if (source === 'env') {
      fix = `Point ${FFMPEG_PATH_ENV} at a working ffmpeg binary, or unset it.`;
    } else if (source === 'bundled') {
      fix = `Install FFmpeg (${install}) and set ${FFMPEG_PATH_ENV} to its path.`;
    } else if (inExtension(deps)) {
      fix = `The Claude Desktop extension doesn't include FFmpeg: install it (${install}). ${found}`;
    } else if (deps.bundledFfmpeg !== null) {
      fix =
        "ffmpeg-static's FFmpeg isn't installed: it downloads in an install script, which was skipped " +
        "(npm's --ignore-scripts, or a package manager that blocks build scripts). " +
        `Reinstall with install scripts allowed, or install FFmpeg (${install}). ${found}`;
    } else {
      fix = `ffmpeg-static has no build for this platform. Install FFmpeg (${install}). ${found}`;
    }
    return {
      check: {
        ...base,
        status: 'fail',
        detail: `${path} (${SOURCE_NAMES[source]}) doesn't run: ${reason(err)}.`,
        fix,
      },
      filters: null,
    };
  }
}

const SKIPPED = 'Not checked: FFmpeg did not run.';

function checkDrawtext(filters: Set<string> | null): DoctorCheck {
  const base = { id: 'drawtext', label: 'Text and captions' } as const;
  if (!filters) return { ...base, status: 'skip', detail: SKIPPED };
  if (filters.has('drawtext')) return { ...base, status: 'ok', detail: 'drawtext filter' };
  return {
    ...base,
    status: 'warn',
    detail:
      'This FFmpeg has no drawtext filter (it needs libfreetype and libharfbuzz), so text, title cards and captions cannot render.',
    fix:
      `Set ${FFMPEG_PATH_ENV} to an FFmpeg that lists drawtext in \`ffmpeg -hide_banner -filters\`. ` +
      `On Debian or Ubuntu: \`sudo apt install ffmpeg\`, then \`export ${FFMPEG_PATH_ENV}=/usr/bin/ffmpeg\`.`,
  };
}

function checkVidstab(filters: Set<string> | null): DoctorCheck {
  const base = { id: 'vidstab', label: 'Stabilization' } as const;
  if (!filters) return { ...base, status: 'skip', detail: SKIPPED };
  if (filters.has('vidstabdetect') && filters.has('vidstabtransform')) {
    return { ...base, status: 'ok', detail: 'vidstab filters' };
  }
  return {
    ...base,
    status: 'warn',
    detail: 'This FFmpeg has no vidstab filters (libvidstab), so `clip stabilize` cannot run.',
    fix: `Set ${FFMPEG_PATH_ENV} to an FFmpeg built with libvidstab (it lists vidstabdetect in \`ffmpeg -hide_banner -filters\`).`,
  };
}

async function checkWorkspace(deps: DoctorDeps): Promise<DoctorCheck> {
  const base = { id: 'workspace', label: 'Workspace' } as const;
  const where = deps.env[WORKSPACE_ENV] === undefined ? 'default' : WORKSPACE_ENV;
  try {
    await deps.probeWritable(deps.workspace);
    return { ...base, status: 'ok', detail: `${deps.workspace} (${where})` };
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      detail: `Cannot write to ${deps.workspace} (${where}): ${reason(err)}.`,
      fix: `Set ${WORKSPACE_ENV} to a folder you can write to; the editor keeps its timeline, imports and exports there.`,
    };
  }
}

function checkFont(deps: DoctorDeps): DoctorCheck {
  const base = { id: 'font', label: 'Caption font' } as const;
  const font = deps.captionFont();
  const explicit = deps.env[FALLBACK_FONT_ENV];
  if (explicit && font !== explicit) {
    return {
      ...base,
      status: 'warn',
      detail: `${FALLBACK_FONT_ENV} (${explicit}) is missing, unreadable or has no Latin letters; captions use ${font ?? "FFmpeg's default font"}.`,
      fix: `Point ${FALLBACK_FONT_ENV} at a .ttf, .otf or .ttc file, or unset it.`,
    };
  }
  if (font) return { ...base, status: 'ok', detail: font };
  const setFont = `${FALLBACK_FONT_ENV} to a .ttf, .otf or .ttc file`;
  return {
    ...base,
    status: 'warn',
    detail:
      'No known font file found, so captions ask FFmpeg for its default font: slow per caption, and it fails on builds without fontconfig.',
    fix:
      deps.platform === 'linux'
        ? `On Debian or Ubuntu, \`sudo apt install fonts-dejavu-core\`, or set ${setFont}.`
        : `Set ${setFont}.`,
  };
}

const WHISPER_PURPOSE = 'Optional: transcript cuts, retake removal and captions need it.';

async function checkWhisper(deps: DoctorDeps): Promise<DoctorCheck> {
  const base = { id: 'whisper', label: 'whisper.cpp (optional)' } as const;
  const { path: binary, source } = whisperBinary({
    env: deps.env,
    platform: deps.platform,
    isFile: deps.isFile,
  });
  const where = source === 'env' ? WHISPER_PATH_ENV : 'installed';
  try {
    await deps.run(binary, ['--help']);
  } catch (err) {
    // Some builds exit non-zero after printing help; one that can't load its
    // libraries exits non-zero too, but prints no usage line.
    if (!printedHelp(err)) {
      const install =
        deps.platform === 'darwin'
          ? '`brew install whisper-cpp`'
          : 'build it from https://github.com/ggml-org/whisper.cpp';
      return {
        ...base,
        status: 'warn',
        detail: `${binary} (${where}) doesn't run: ${reason(err)}. ${WHISPER_PURPOSE}`,
        fix:
          source === 'system'
            ? `Install or reinstall whisper.cpp (${install}). whisper-cli is found on PATH and in Homebrew's folder; or set ${WHISPER_PATH_ENV} to it.`
            : `Point ${WHISPER_PATH_ENV} at the whisper-cli binary, or unset it.`,
      };
    }
  }
  return { ...base, status: 'ok', detail: `${binary} (${where})` };
}

function printedHelp(err: unknown): boolean {
  const e = (err ?? {}) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
  return typeof e.exitCode === 'number' && /usage:/i.test(`${e.stdout ?? ''}\n${e.stderr ?? ''}`);
}

function checkWhisperModel(deps: DoctorDeps): DoctorCheck {
  const base = { id: 'whisper-model', label: 'Whisper model (optional)' } as const;
  const model = deps.env[WHISPER_MODEL_ENV];
  const fix = `Download a model such as ggml-base.en.bin from https://huggingface.co/ggerganov/whisper.cpp and set ${WHISPER_MODEL_ENV} to its path.`;
  if (model === undefined || model === '') {
    return {
      ...base,
      status: 'warn',
      detail: `${WHISPER_MODEL_ENV} is not set. ${WHISPER_PURPOSE}`,
      fix,
    };
  }
  if (!deps.isFile(model)) {
    return {
      ...base,
      status: 'warn',
      detail: `${WHISPER_MODEL_ENV} points at ${model}, which is not a file.`,
      fix,
    };
  }
  return { ...base, status: 'ok', detail: model };
}

function reason(err: unknown): string {
  const e = (err ?? {}) as {
    code?: unknown;
    shortMessage?: unknown;
    message?: unknown;
    stderr?: unknown;
  };
  if (e.code === 'ENOENT') return 'not found';
  if (e.code === 'EACCES') return 'permission denied';
  const text = typeof e.shortMessage === 'string' ? e.shortMessage : (e.message ?? String(err));
  const firstLine = String(text).split('\n')[0] ?? '';
  // A binary that starts and dies says why on stderr (a missing shared library).
  const said =
    typeof e.stderr === 'string' ? e.stderr.split('\n').find((l) => l.trim()) : undefined;
  return said ? `${firstLine} (${said.trim()})` : firstLine;
}

const MARKS: Record<DoctorStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

/** The report as terminal text: one line per check, a fix under each problem. */
export function formatDoctorReport(result: DoctorResult): string {
  const width = Math.max(...result.checks.map((c) => c.label.length));
  const lines = ['MakeMyClip Editor setup', ''];
  for (const c of result.checks) {
    lines.push(`  ${MARKS[c.status]} ${c.label.padEnd(width)}  ${c.detail}`);
    if (c.fix) lines.push(`    ${' '.repeat(width)}  Fix: ${c.fix}`);
  }
  const fails = result.checks.filter((c) => c.status === 'fail').length;
  const warns = result.checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  if (fails > 0) lines.push(`Not ready: ${plural(fails, 'problem')} to fix.`);
  else if (warns > 0)
    lines.push(`Ready. ${plural(warns, 'warning')}: those features stay off until fixed.`);
  else lines.push('Ready. Everything is set up.');
  if (fails + warns > 0) lines.push(result.howToSet);
  return `${lines.join('\n')}\n`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
