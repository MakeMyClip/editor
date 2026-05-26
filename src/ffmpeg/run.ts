import { execa } from 'execa';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

export interface FfmpegResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runFfmpeg(args: string[]): Promise<FfmpegResult> {
  const start = Date.now();
  const { stdout, stderr } = await execa(ffmpegInstaller.path, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout, stderr, durationMs: Date.now() - start };
}
