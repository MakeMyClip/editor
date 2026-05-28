import { describe, expect, it } from 'vitest';
import {
  allPlayableClips,
  clipKey,
  type PlayableClip,
  playableClipsFrom,
} from '../src/ui/web/src/lib/playable-clips.js';

// Minimal SessionEntry shape — only fields the helper inspects.
function entry(over: {
  id?: string;
  tool: string;
  args?: Record<string, unknown>;
  result: Record<string, unknown>;
}) {
  return {
    id: over.id ?? 'op_test',
    tool: over.tool,
    args: over.args ?? {},
    result: over.result,
    timestamp: '2026-05-28T16:30:00.000Z',
  };
}

describe('playableClipsFrom', () => {
  it('reads ingest from result.ref.path and strips random prefix', () => {
    const clips = playableClipsFrom(
      entry({
        tool: 'ingest',
        result: { ref: { path: '/tmp/workspace/imports/2e0d99ef-demo.mp4' } },
      }),
    );
    expect(clips).toHaveLength(1);
    expect(clips[0]?.path).toBe('/tmp/workspace/imports/2e0d99ef-demo.mp4');
    expect(clips[0]?.label).toBe('demo.mp4'); // strips the 8-hex-char prefix
  });

  it('reads most ops from result.path', () => {
    const clips = playableClipsFrom(
      entry({ tool: 'trim', result: { path: '/tmp/workspace/trim-abcdef12.mp4' } }),
    );
    expect(clips).toHaveLength(1);
    expect(clips[0]?.tool).toBe('trim');
  });

  it('expands split into before + after', () => {
    const clips = playableClipsFrom(
      entry({
        id: 'op_split1',
        tool: 'split',
        result: { before: '/tmp/before-aa.mp4', after: '/tmp/after-bb.mp4' },
      }),
    );
    expect(clips).toHaveLength(2);
    expect(clips.map((c) => c.subId)).toEqual(['before', 'after']);
    expect(clips[0]?.opId).toBe('op_split1');
    expect(clips[1]?.opId).toBe('op_split1');
  });

  it('skips non-video results (preview jpeg, missing path)', () => {
    const preview = playableClipsFrom(
      entry({ tool: 'preview', result: { path: '/tmp/preview-aa.jpg' } }),
    );
    expect(preview).toEqual([]);

    const nothing = playableClipsFrom(entry({ tool: 'inspect', result: {} }));
    expect(nothing).toEqual([]);
  });

  it('skips ingest of non-video media', () => {
    const audioIngest = playableClipsFrom(
      entry({ tool: 'ingest', result: { ref: { path: '/tmp/song.mp3' } } }),
    );
    expect(audioIngest).toEqual([]);
  });

  it('accepts common video extensions (mp4, mov, webm, mkv, m4v)', () => {
    for (const ext of ['mp4', 'mov', 'webm', 'mkv', 'm4v']) {
      const clips = playableClipsFrom(
        entry({ tool: 'render', result: { path: `/tmp/out-aa.${ext}` } }),
      );
      expect(clips, ext).toHaveLength(1);
    }
  });
});

describe('allPlayableClips', () => {
  it('preserves entry order and expands splits in place', () => {
    const flat = allPlayableClips([
      entry({ id: 'op_a', tool: 'ingest', result: { ref: { path: '/tmp/a.mp4' } } }),
      entry({
        id: 'op_b',
        tool: 'split',
        result: { before: '/tmp/b1.mp4', after: '/tmp/b2.mp4' },
      }),
      entry({ id: 'op_c', tool: 'trim', result: { path: '/tmp/c.mp4' } }),
    ]);
    expect(flat.map((c) => `${c.opId}${c.subId ? `#${c.subId}` : ''}`)).toEqual([
      'op_a',
      'op_b#before',
      'op_b#after',
      'op_c',
    ]);
  });

  it('drops entries that contribute no playable clip', () => {
    const flat = allPlayableClips([
      entry({ id: 'op_p', tool: 'preview', result: { path: '/tmp/p.jpg' } }),
      entry({ id: 'op_t', tool: 'trim', result: { path: '/tmp/t.mp4' } }),
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0]?.opId).toBe('op_t');
  });
});

describe('clipKey', () => {
  it('uses opId alone when no subId', () => {
    expect(clipKey({ opId: 'op_x' } as PlayableClip)).toBe('op_x');
  });

  it('disambiguates split halves', () => {
    expect(clipKey({ opId: 'op_y', subId: 'before' } as PlayableClip)).toBe('op_y#before');
    expect(clipKey({ opId: 'op_y', subId: 'after' } as PlayableClip)).toBe('op_y#after');
  });
});
