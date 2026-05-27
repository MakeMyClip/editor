import { execa } from 'execa';
import ffmpegStatic from 'ffmpeg-static';

const ffmpegPath = process.env.MAKEMYCLIP_FFMPEG_PATH ?? ffmpegStatic ?? 'ffmpeg';

export interface VideoStream {
  codec: string;
  width: number;
  height: number;
  fps: number;
}

export interface AudioStream {
  codec: string;
  sampleRate: number;
  channels: string;
}

export interface MediaProbe {
  durationSec: number;
  video: VideoStream | null;
  audio: AudioStream | null;
}

/**
 * Probe a media file by invoking ffmpeg with `-f null -` and parsing the
 * structured stderr output. We use ffmpeg rather than ffprobe because
 * ffmpeg-static doesn't bundle ffprobe and the maintained ffprobe wrappers
 * ship stale binaries that drift from our ffmpeg version.
 *
 * LC_ALL=C forces English output so the regexes are stable across user locales.
 */
export async function probe(inputPath: string): Promise<MediaProbe> {
  const { stderr, exitCode } = await execa(
    ffmpegPath,
    ['-hide_banner', '-i', inputPath, '-f', 'null', '-'],
    {
      reject: false,
      env: { ...process.env, LC_ALL: 'C' },
    },
  );

  // ffmpeg exits non-zero when the input is missing or unreadable.
  // With `-f null -` it exits 0 on a valid input even though no output is written.
  if (exitCode !== 0 && exitCode !== null) {
    throw new Error(`ffmpeg probe failed for ${inputPath} (exit ${exitCode}):\n${stderr}`);
  }

  return parseProbeOutput(stderr);
}

export function parseProbeOutput(stderr: string): MediaProbe {
  return {
    durationSec: parseDuration(stderr),
    video: parseVideoStream(stderr),
    audio: parseAudioStream(stderr),
  };
}

function parseDuration(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!m?.[1] || !m[2] || !m[3]) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseVideoStream(stderr: string): VideoStream | null {
  for (const line of stderr.split('\n')) {
    if (!/Stream\s+#\d+:\d+/.test(line) || !/\bVideo:/.test(line)) continue;

    const codec = line.match(/Video:\s+([a-z0-9_]+)/i)?.[1];
    const dims = line.match(/(\d{2,5})x(\d{2,5})/);
    // fps appears as "30 fps" or "29.97 fps" — take the first match since
    // ffmpeg may also print "tbr" with a similar shape but a different keyword.
    const fps = line.match(/([\d.]+)\s+fps\b/)?.[1];

    if (!codec || !dims?.[1] || !dims[2]) continue;

    return {
      codec,
      width: Number(dims[1]),
      height: Number(dims[2]),
      fps: fps ? Number(fps) : 0,
    };
  }
  return null;
}

function parseAudioStream(stderr: string): AudioStream | null {
  for (const line of stderr.split('\n')) {
    if (!/Stream\s+#\d+:\d+/.test(line) || !/\bAudio:/.test(line)) continue;

    const codec = line.match(/Audio:\s+([a-z0-9_]+)/i)?.[1];
    const sampleRate = line.match(/(\d{4,6})\s*Hz/)?.[1];
    // Channels are always listed right after "<rate> Hz, " so we anchor the
    // match there. Without the anchor the bare-digit alternative happily eats
    // the sample rate itself ("48000") and we'd never reach "stereo".
    const channels = line.match(/\d+\s*Hz,\s*((?:mono|stereo|[\d.]+)(?:\([^)]+\))?)/)?.[1];

    if (!codec) continue;

    return {
      codec,
      sampleRate: sampleRate ? Number(sampleRate) : 0,
      channels: channels ?? 'unknown',
    };
  }
  return null;
}
