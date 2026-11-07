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
      isFile: (path: string) => files.includes(path),
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
      isFile: (path) => path === exe,
    });
    expect(found).toBe(exe);
  });

  it('returns the bare name when nothing is installed', () => {
    expect(
      findSystemBinary('whisper-cli', {
        env: { PATH: '/usr/bin' },
        platform: 'linux',
        isFile: () => false,
      }),
    ).toBe('whisper-cli');
  });
});
