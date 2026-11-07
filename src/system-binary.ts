import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Where to look; tests pass stubs, everything else defaults to this process. */
export interface SystemLookup {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => boolean;
}

/**
 * A setting read from the environment. Empty counts as unset: the Claude
 * Desktop extension passes "" for a setting the user left blank.
 */
export function envSetting(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A file this process may run. Windows has no execute bit, so a file is enough there. */
export function isExecutable(path: string): boolean {
  if (!isFile(path)) return false;
  if (process.platform === 'win32') return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Package-manager folders that an app opened from the Dock or the Start menu
 *  often lacks on PATH, which is how Claude Desktop starts the extension. */
function installDirs(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  if (platform === 'win32') {
    const dirs: string[] = [];
    if (env.LOCALAPPDATA) dirs.push(win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    if (env.USERPROFILE) dirs.push(win32.join(env.USERPROFILE, 'scoop', 'shims'));
    dirs.push(win32.join(env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin'));
    return dirs;
  }
  return ['/usr/local/bin', '/usr/bin'];
}

/**
 * The full path of an installed `name` executable: the first one on PATH, then
 * in Homebrew's, MacPorts', winget's, Scoop's or Chocolatey's folder. Returns
 * the bare name when none is found, so the OS lookup (and its error) applies.
 */
export function findSystemBinary(name: string, lookup: SystemLookup = {}): string {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const runnable = lookup.isExecutable ?? isExecutable;
  const path = platform === 'win32' ? win32 : posix;
  const pathVar = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const file = platform === 'win32' ? `${name}.exe` : name;
  const dirs = [...pathVar.split(path.delimiter).filter(Boolean), ...installDirs(platform, env)];
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (runnable(candidate)) return candidate;
  }
  return name;
}
