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
