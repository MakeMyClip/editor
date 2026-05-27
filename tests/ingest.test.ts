import { describe, expect, it } from 'vitest';
import { parseProbeOutput } from '../src/ffmpeg/probe.js';
import { MediaIdSchema, makeMediaId } from '../src/timeline/schema.js';
import { IngestInput } from '../src/tools/ingest.js';

describe('parseProbeOutput', () => {
  it('parses a standard mp4 with video + audio', () => {
    const stderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'test.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:00:03.50, start: 0.000000, bitrate: 1234 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1200 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 192 kb/s (default)
`;
    const probe = parseProbeOutput(stderr);
    expect(probe.durationSec).toBe(3.5);
    expect(probe.video).toEqual({ codec: 'h264', width: 1920, height: 1080, fps: 30 });
    expect(probe.audio).toEqual({ codec: 'aac', sampleRate: 48000, channels: 'stereo' });
  });

  it('handles video-only files', () => {
    const stderr = `
Input #0:
  Duration: 00:00:01.00, start: 0.000000, bitrate: 39 kb/s
  Stream #0:0: Video: h264, yuv420p, 320x240, 30 fps, 30 tbr
`;
    const probe = parseProbeOutput(stderr);
    expect(probe.video).not.toBeNull();
    expect(probe.audio).toBeNull();
  });

  it('handles audio-only files', () => {
    const stderr = `
Input #0, mp3, from 'song.mp3':
  Duration: 00:03:24.50, start: 0.025057, bitrate: 192 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 192 kb/s
`;
    const probe = parseProbeOutput(stderr);
    expect(probe.video).toBeNull();
    expect(probe.audio).toEqual({ codec: 'mp3', sampleRate: 44100, channels: 'stereo' });
    expect(probe.durationSec).toBeCloseTo(204.5, 1);
  });

  it('takes the first stream of each type when multiple exist', () => {
    const stderr = `
Input #0:
  Duration: 00:00:10.00, start: 0.000000, bitrate: 1234 kb/s
  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps, 30 tbr
  Stream #0:1: Video: hevc, yuv420p, 640x480, 60 fps, 60 tbr
  Stream #0:2: Audio: aac, 48000 Hz, stereo, fltp
  Stream #0:3: Audio: opus, 24000 Hz, mono, fltp
`;
    const probe = parseProbeOutput(stderr);
    expect(probe.video?.codec).toBe('h264');
    expect(probe.video?.width).toBe(1920);
    expect(probe.audio?.codec).toBe('aac');
    expect(probe.audio?.sampleRate).toBe(48000);
  });

  it('parses 5.1 surround audio channels', () => {
    const stderr = `
Input #0:
  Duration: 00:00:05.00, start: 0.000000, bitrate: 1234 kb/s
  Stream #0:0: Audio: aac, 48000 Hz, 5.1(side), fltp, 384 kb/s
`;
    const probe = parseProbeOutput(stderr);
    expect(probe.audio?.channels).toBe('5.1(side)');
  });

  it('parses fractional fps (29.97)', () => {
    const stderr = `
  Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s
  Stream #0:0: Video: h264, yuv420p, 1280x720, 29.97 fps, 29.97 tbr
`;
    const probe = parseProbeOutput(stderr);
    expect(probe.video?.fps).toBeCloseTo(29.97, 2);
  });

  it('parses 4K dimensions', () => {
    const stderr = `
  Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s
  Stream #0:0: Video: hevc, yuv420p10le, 3840x2160, 60 fps, 60 tbr
`;
    const probe = parseProbeOutput(stderr);
    expect(probe.video?.width).toBe(3840);
    expect(probe.video?.height).toBe(2160);
  });

  it('returns 0 duration when Duration line is missing', () => {
    const stderr = 'Some garbage with no Duration line\n';
    const probe = parseProbeOutput(stderr);
    expect(probe.durationSec).toBe(0);
  });

  it('returns null streams when no Stream lines exist', () => {
    const stderr = 'Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s\n';
    const probe = parseProbeOutput(stderr);
    expect(probe.video).toBeNull();
    expect(probe.audio).toBeNull();
  });

  it('does not confuse tbr with fps', () => {
    // ffmpeg lists "30 fps, 30 tbr" — make sure we pick fps, not tbr's number
    const stderr = `
  Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s
  Stream #0:0: Video: h264, yuv420p, 640x360, 24 fps, 30 tbr
`;
    const probe = parseProbeOutput(stderr);
    expect(probe.video?.fps).toBe(24);
  });
});

describe('makeMediaId', () => {
  it('is deterministic for the same absolute path', () => {
    expect(makeMediaId('/abs/path/to/file.mp4')).toBe(makeMediaId('/abs/path/to/file.mp4'));
  });

  it('produces different ids for different paths', () => {
    expect(makeMediaId('/a.mp4')).not.toBe(makeMediaId('/b.mp4'));
  });

  it('matches the MediaIdSchema regex', () => {
    expect(() => MediaIdSchema.parse(makeMediaId('/x'))).not.toThrow();
  });

  it('id length is always m_ + 12 hex chars', () => {
    const id = makeMediaId('/some/path');
    expect(id).toMatch(/^m_[a-f0-9]{12}$/);
    expect(id.length).toBe(14);
  });
});

describe('IngestInput', () => {
  it('accepts a valid path', () => {
    expect(() => IngestInput.parse({ path: 'video.mp4' })).not.toThrow();
  });

  it('rejects empty path', () => {
    expect(() => IngestInput.parse({ path: '' })).toThrow();
  });

  it('rejects missing path', () => {
    expect(() => IngestInput.parse({})).toThrow();
  });
});
