import { describe, expect, it } from 'vitest';
import { clipLabel, mediaNames } from '../src/ui/web/src/lib/composition.js';
import type { Clip, SessionEntry } from '../src/ui/web/src/types.js';

function ingest(mediaId: string, path: string): SessionEntry {
  return {
    id: `op_${mediaId}`,
    tool: 'ingest',
    args: { path },
    result: { mediaId, ref: { path, audio: null, video: null } },
    timestamp: '2026-05-28T16:30:00.000Z',
  };
}

function mediaClip(mediaId: string): Clip {
  return {
    kind: 'media',
    id: 'clip_1',
    mediaId,
    startSec: 0,
    sourceInSec: 0,
    sourceOutSec: 5,
  };
}

describe('mediaNames', () => {
  it("maps each ingested media id to its file's base name", () => {
    const names = mediaNames([
      ingest('m_aaa', '/work/media/talking.mp4'),
      ingest('m_bbb', '/work/imports/2e0d99ef-broll.mov'),
    ]);
    expect(names.get('m_aaa')).toBe('talking.mp4');
    expect(names.get('m_bbb')).toBe('broll.mov'); // strips the import prefix
  });

  it('skips non-ingest entries and ingest results without a media id or path', () => {
    const names = mediaNames([
      {
        id: 'op_trim',
        tool: 'trim',
        args: {},
        result: { mediaId: 'm_x', path: '/work/out.mp4' },
        timestamp: '2026-05-28T16:30:00.000Z',
      },
      {
        id: 'op_bad',
        tool: 'ingest',
        args: {},
        result: { ref: { path: '/work/no-id.mp4' } },
        timestamp: '2026-05-28T16:30:00.000Z',
      },
    ]);
    expect(names.size).toBe(0);
  });
});

describe('clipLabel', () => {
  it('labels a media clip with its file name', () => {
    const names = mediaNames([ingest('m_aaa', '/work/media/talking.mp4')]);
    expect(clipLabel(mediaClip('m_aaa'), names)).toBe('talking.mp4');
  });

  it('falls back to the media id when the name is unknown', () => {
    expect(clipLabel(mediaClip('m_821d98105d7c'), new Map())).toBe('m_821d98105d7c');
  });

  it('labels text and color clips by their content', () => {
    const names = new Map<string, string>();
    expect(
      clipLabel({ kind: 'text', id: 'c_t', startSec: 0, text: 'Hello', durationSec: 2 }, names),
    ).toBe('“Hello”');
    expect(
      clipLabel({ kind: 'color', id: 'c_c', startSec: 0, color: 'black', durationSec: 2 }, names),
    ).toBe('color · black');
  });
});
