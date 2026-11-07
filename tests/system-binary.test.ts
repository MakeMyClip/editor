import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envSetting, findSystemBinary } from '../src/system-binary.js';

describe('envSetting', () => {
  it('treats an empty value as unset', () => {
    expect(envSetting('X', { X: '/a' })).toBe('/a');
    expect(envSetting('X', { X: '' })).toBeUndefined();
    expect(envSetting('X', {})).toBeUndefined();
  });
});

describe('findSystemBinary', () => {
  it('takes the first match on PATH before the install folders', () => {
    const files = ['/home/me/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
    const lookup = {
      env: { PATH: '/usr/bin:/home/me/bin' },
      platform: 'darwin' as const,
      isExecutable: (path: string) => files.includes(path),
    };
    expect(findSystemBinary('ffmpeg', lookup)).toBe('/home/me/bin/ffmpeg');
    expect(findSystemBinary('ffmpeg', { ...lookup, env: { PATH: '/usr/bin:/bin' } })).toBe(
      '/opt/homebrew/bin/ffmpeg',
    );
  });

  it("looks in winget's links folder for an .exe on Windows", () => {
    const exe = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
    const found = findSystemBinary('ffmpeg', {
      env: { Path: 'C:\\Windows\\system32', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      platform: 'win32',
      isExecutable: (path) => path === exe,
    });
    expect(found).toBe(exe);
  });

  it('returns the bare name when nothing is installed', () => {
    expect(
      findSystemBinary('whisper-cli', {
        env: { PATH: '/usr/bin' },
        platform: 'linux',
        isExecutable: () => false,
      }),
    ).toBe('whisper-cli');
  });

  it.skipIf(process.platform === 'win32')(
    'skips a file on PATH that is not executable',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mmc-which-'));
      try {
        const [first, second] = [join(dir, 'a'), join(dir, 'b')];
        await mkdir(first);
        await mkdir(second);
        await writeFile(join(first, 'ffmpeg'), '');
        await writeFile(join(second, 'ffmpeg'), '#!/bin/sh\n');
        await chmod(join(second, 'ffmpeg'), 0o755);
        const env = { PATH: `${first}:${second}` };

        expect(findSystemBinary('ffmpeg', { env, platform: 'linux' })).toBe(join(second, 'ffmpeg'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
