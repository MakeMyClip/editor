import { describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../src/ffmpeg/run.js';
import {
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorDeps,
  doctor,
  formatDoctorReport,
} from '../src/tools/doctor.js';

const BUNDLED = '/pkg/node_modules/ffmpeg-static/ffmpeg';
const FILTERS = [
  'Filters:',
  ' T.C drawtext          V->V       Draw text on top of video frames using libfreetype library.',
  ' ... vidstabdetect     V->V       Extract relative transformations, pass 1 of 2.',
  ' ... vidstabtransform  V->V       Transform the frames, pass 2 of 2.',
  ' TSC scale             V->V       Scale the input video size.',
  '',
].join('\n');

function spawnError(code: string): Error {
  return Object.assign(new Error(`spawn ${code}`), { code });
}

function exitError(exitCode: number, stderr: string): Error {
  return Object.assign(new Error(`Command failed with exit code ${exitCode}`), {
    shortMessage: `Command failed with exit code ${exitCode}`,
    exitCode,
    stdout: '',
    stderr,
  });
}

/** A machine where everything is set up; each test breaks one thing. */
function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    env: { MAKEMYCLIP_WHISPER_MODEL: '/models/ggml-base.en.bin' },
    platform: 'linux',
    nodeVersion: '24.1.0',
    bundledFfmpeg: BUNDLED,
    workspace: '/ws',
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes('-version')) return { stdout: 'ffmpeg version 7.1.1 Copyright (c)\n' };
      if (args.includes('-filters')) return { stdout: FILTERS };
      return { stdout: 'usage: whisper-cli [options] file0 file1 ...\n' };
    },
    isFile: (path) => path.endsWith('.bin'),
    isExecutable: (path) => path === BUNDLED,
    probeWritable: async () => undefined,
    captionFont: () => '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ...overrides,
  };
}

function check(checks: DoctorCheck[], id: DoctorCheckId): DoctorCheck {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

describe('resolveFfmpeg', () => {
  const lookup = {
    env: { PATH: '/usr/bin' },
    platform: 'darwin' as const,
    bundled: BUNDLED,
    isExecutable: (path: string) => path === BUNDLED || path === '/opt/homebrew/bin/ffmpeg',
  };

  it('prefers the env override, then the bundled binary, then an installed FFmpeg', () => {
    expect(resolveFfmpeg({ ...lookup, env: { MAKEMYCLIP_FFMPEG_PATH: '/opt/ffmpeg' } })).toEqual({
      path: '/opt/ffmpeg',
      source: 'env',
    });
    expect(resolveFfmpeg(lookup)).toEqual({ path: BUNDLED, source: 'bundled' });
    expect(resolveFfmpeg({ ...lookup, bundled: null })).toEqual({
      path: '/opt/homebrew/bin/ffmpeg',
      source: 'system',
    });
  });

  it('skips a bundled binary that is not on disk, and an empty override', () => {
    const missing = {
      ...lookup,
      isExecutable: (path: string) => path === '/opt/homebrew/bin/ffmpeg',
    };
    expect(resolveFfmpeg(missing)).toEqual({ path: '/opt/homebrew/bin/ffmpeg', source: 'system' });
    expect(resolveFfmpeg({ ...lookup, env: { MAKEMYCLIP_FFMPEG_PATH: '' } }).source).toBe(
      'bundled',
    );
    expect(resolveFfmpeg({ ...missing, isExecutable: () => false })).toEqual({
      path: 'ffmpeg',
      source: 'system',
    });
  });
});

describe('doctor', () => {
  it('passes every check on a set-up machine, in a stable order', async () => {
    const d = deps();
    const result = await doctor({}, d);

    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => [c.id, c.status])).toEqual([
      ['node', 'ok'],
      ['ffmpeg', 'ok'],
      ['drawtext', 'ok'],
      ['vidstab', 'ok'],
      ['workspace', 'ok'],
      ['font', 'ok'],
      ['whisper', 'ok'],
      ['whisper-model', 'ok'],
    ]);
    expect(result.checks.every((c) => c.fix === undefined)).toBe(true);
    expect(check(result.checks, 'ffmpeg').detail).toBe(`7.1.1 (bundled ffmpeg-static) ${BUNDLED}`);
    expect(check(result.checks, 'workspace').detail).toBe('/ws (default)');
    expect(d.calls).toEqual([
      [BUNDLED, '-hide_banner', '-version'],
      [BUNDLED, '-hide_banner', '-filters'],
      ['whisper-cli', '--help'],
    ]);
  });

  it('fails on a Node older than the engines field', async () => {
    const result = await doctor({}, deps({ nodeVersion: '22.11.0' }));

    expect(result.ok).toBe(false);
    expect(check(result.checks, 'node')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('Node 24+'),
    });
  });

  it('fails on a broken FFmpeg override and skips the filter checks', async () => {
    const result = await doctor(
      {},
      deps({
        env: { MAKEMYCLIP_FFMPEG_PATH: '/nope/ffmpeg' },
        run: async () => {
          throw spawnError('ENOENT');
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(check(result.checks, 'ffmpeg')).toMatchObject({
      status: 'fail',
      detail: "/nope/ffmpeg (MAKEMYCLIP_FFMPEG_PATH) doesn't run: not found.",
      fix: 'Point MAKEMYCLIP_FFMPEG_PATH at a working ffmpeg binary, or unset it.',
    });
    expect(check(result.checks, 'drawtext').status).toBe('skip');
    expect(check(result.checks, 'vidstab').status).toBe('skip');
  });

  it('explains a bundled FFmpeg whose install script never ran', async () => {
    const result = await doctor(
      {},
      deps({
        isExecutable: () => false,
        run: async () => {
          throw spawnError('ENOENT');
        },
      }),
    );

    expect(check(result.checks, 'ffmpeg')).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/install script.*sudo apt install ffmpeg.*MAKEMYCLIP_FFMPEG_PATH/),
    });
  });

  it('points a platform with no bundled build at a system FFmpeg', async () => {
    const result = await doctor(
      {},
      deps({
        platform: 'darwin',
        bundledFfmpeg: null,
        run: async () => {
          throw spawnError('ENOENT');
        },
      }),
    );

    expect(check(result.checks, 'ffmpeg')).toMatchObject({
      status: 'fail',
      detail: "ffmpeg (system) doesn't run: not found.",
      fix: expect.stringContaining('`brew install ffmpeg`'),
    });
  });

  it("finds Homebrew's FFmpeg and whisper-cli for the Claude Desktop extension", async () => {
    const homebrew = ['/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/whisper-cli'];
    const d = deps({
      env: { MAKEMYCLIP_BUNDLE: 'mcpb', PATH: '/usr/bin:/bin', MAKEMYCLIP_WHISPER_MODEL: '' },
      platform: 'darwin',
      isExecutable: (path) => homebrew.includes(path),
    });
    const result = await doctor({}, d);

    expect(check(result.checks, 'ffmpeg').detail).toBe('7.1.1 (system) /opt/homebrew/bin/ffmpeg');
    expect(check(result.checks, 'whisper').detail).toBe(
      '/opt/homebrew/bin/whisper-cli (installed)',
    );
    expect(check(result.checks, 'whisper-model').detail).toContain('is not set');
    expect(result.howToSet).toContain("MakeMyClip Editor extension's settings");
    expect(d.calls.map((c) => c[0])).toEqual([homebrew[0], homebrew[0], homebrew[1]]);
  });

  it('tells extension users to install FFmpeg, which the bundle leaves out', async () => {
    const result = await doctor(
      {},
      deps({
        env: { MAKEMYCLIP_BUNDLE: 'mcpb', MAKEMYCLIP_FFMPEG_PATH: '' },
        platform: 'win32',
        isExecutable: () => false,
        run: async () => {
          throw spawnError('ENOENT');
        },
      }),
    );

    expect(check(result.checks, 'ffmpeg')).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/doesn't include FFmpeg.*winget install Gyan\.FFmpeg/),
    });
    expect(formatDoctorReport(result)).toContain('FFmpeg is MAKEMYCLIP_FFMPEG_PATH');
  });

  it('warns, without failing, when FFmpeg lacks drawtext or vidstab', async () => {
    const result = await doctor(
      {},
      deps({
        run: async (_file, args) => ({
          stdout: args.includes('-version')
            ? 'ffmpeg version 6.1 Copyright\n'
            : ' TSC scale             V->V       Scale the input video size.\n',
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(check(result.checks, 'drawtext')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('MAKEMYCLIP_FFMPEG_PATH=/usr/bin/ffmpeg'),
    });
    expect(check(result.checks, 'vidstab')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('clip stabilize'),
    });
  });

  it('fails when the workspace is not writable', async () => {
    const result = await doctor(
      {},
      deps({
        env: { MAKEMYCLIP_WORKSPACE: '/ro', MAKEMYCLIP_WHISPER_MODEL: '/m.bin' },
        workspace: '/ro',
        probeWritable: async () => {
          throw Object.assign(new Error("EACCES: permission denied, mkdir '/ro'"), {
            code: 'EACCES',
          });
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(check(result.checks, 'workspace')).toMatchObject({
      status: 'fail',
      detail: 'Cannot write to /ro (MAKEMYCLIP_WORKSPACE): permission denied.',
      fix: expect.stringContaining('MAKEMYCLIP_WORKSPACE'),
    });
  });

  it('warns when no caption font is found', async () => {
    const result = await doctor({}, deps({ captionFont: () => undefined }));

    expect(check(result.checks, 'font')).toMatchObject({
      status: 'warn',
      fix: expect.stringMatching(/fonts-dejavu-core.*MAKEMYCLIP_FALLBACK_FONT/),
    });
  });

  it('warns when MAKEMYCLIP_FALLBACK_FONT is set but not used', async () => {
    const result = await doctor(
      {},
      deps({
        env: { MAKEMYCLIP_FALLBACK_FONT: '/fonts/missing.ttf', MAKEMYCLIP_WHISPER_MODEL: '/m.bin' },
      }),
    );

    expect(check(result.checks, 'font')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('/fonts/missing.ttf'),
    });
  });

  it('warns about a missing whisper.cpp with the platform install', async () => {
    const result = await doctor(
      {},
      deps({
        platform: 'darwin',
        run: async (file, args) => {
          if (file === 'whisper-cli') throw spawnError('ENOENT');
          return deps().run(file, args);
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(check(result.checks, 'whisper')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('`brew install whisper-cpp`'),
    });
  });

  it('accepts a whisper.cpp that exits non-zero for --help', async () => {
    const result = await doctor(
      {},
      deps({
        env: { MAKEMYCLIP_WHISPER_PATH: '/bin/whisper', MAKEMYCLIP_WHISPER_MODEL: '/m.bin' },
        run: async (file, args) => {
          if (file === '/bin/whisper') throw exitError(1, '\nusage: whisper-cli [options] file0\n');
          return deps().run(file, args);
        },
      }),
    );

    expect(check(result.checks, 'whisper')).toMatchObject({
      status: 'ok',
      detail: '/bin/whisper (MAKEMYCLIP_WHISPER_PATH)',
    });
  });

  it('warns about a whisper.cpp that exits without printing help', async () => {
    const result = await doctor(
      {},
      deps({
        run: async (file, args) => {
          if (file === 'whisper-cli') {
            throw exitError(
              127,
              'whisper-cli: error while loading shared libraries: libwhisper.so.1',
            );
          }
          return deps().run(file, args);
        },
      }),
    );

    expect(check(result.checks, 'whisper')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('libwhisper.so.1'),
      fix: expect.stringContaining('reinstall whisper.cpp'),
    });
  });

  it('warns when the whisper model is unset or missing', async () => {
    const unset = await doctor({}, deps({ env: {} }));
    const missing = await doctor(
      {},
      deps({ isFile: (path) => path !== '/models/ggml-base.en.bin' }),
    );

    expect(check(unset.checks, 'whisper-model')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('MAKEMYCLIP_WHISPER_MODEL is not set'),
      fix: expect.stringContaining('ggml-base.en.bin'),
    });
    expect(check(missing.checks, 'whisper-model')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('not a file'),
    });
  });
});

describe('formatDoctorReport', () => {
  it('prints one line per check, a fix under each problem, and a verdict', async () => {
    const ready = formatDoctorReport(await doctor({}, deps()));
    const warned = formatDoctorReport(await doctor({}, deps({ env: {} })));
    const broken = formatDoctorReport(await doctor({}, deps({ nodeVersion: '20.0.0' })));

    expect(ready).toContain('✓ FFmpeg');
    expect(ready).toContain('Ready. Everything is set up.');
    expect(ready).not.toContain('Fix:');
    expect(warned).toContain('! Whisper model (optional)');
    expect(warned).toContain('Fix: Download a model');
    expect(warned).toContain('Ready. 1 warning: those features stay off until fixed.');
    expect(broken).toContain('✗ Node.js');
    expect(broken).toContain('Not ready: 1 problem to fix.');
  });
});
