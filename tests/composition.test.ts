import { describe, expect, it } from 'vitest';
import {
  type Clip,
  CompositionSchema,
  clipDuration,
  compositionDuration,
  emptyComposition,
  findClip,
} from '../src/timeline/composition.js';
import type { MediaId } from '../src/timeline/schema.js';

const M1 = 'm_aaaaaaaaaaaa' as MediaId;

describe('CompositionSchema', () => {
  it('fills canvas + track/clip defaults', () => {
    const comp = emptyComposition();
    expect(comp).toMatchObject({
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      background: 'black',
    });
    expect(comp.tracks).toEqual([]);
  });

  it('honors a custom canvas', () => {
    const comp = emptyComposition({ width: 1080, height: 1920, fps: 60 });
    expect(comp.width).toBe(1080);
    expect(comp.height).toBe(1920);
    expect(comp.fps).toBe(60);
  });

  it('parses a full multi-track document and fills clip defaults', () => {
    const comp = CompositionSchema.parse({
      version: 1,
      tracks: [
        {
          id: 'v0',
          kind: 'video',
          clips: [{ kind: 'media', id: 'c1', mediaId: M1, sourceOutSec: 5, startSec: 0 }],
        },
      ],
    });
    const clip = comp.tracks[0]?.clips[0];
    expect(clip).toMatchObject({ kind: 'media', sourceInSec: 0, sourceOutSec: 5, effects: [] });
  });

  it('rejects a media clip with a bad mediaId', () => {
    expect(() =>
      CompositionSchema.parse({
        version: 1,
        tracks: [
          {
            id: 'v0',
            kind: 'video',
            clips: [
              { kind: 'media', id: 'c1', mediaId: 'not-a-media-id', sourceOutSec: 5, startSec: 0 },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects an unknown clip kind', () => {
    expect(() =>
      CompositionSchema.parse({
        version: 1,
        tracks: [{ id: 'v0', kind: 'video', clips: [{ kind: 'sticker', id: 'c1', startSec: 0 }] }],
      }),
    ).toThrow();
  });
});

describe('derived geometry', () => {
  it('clipDuration is sourceOut − sourceIn for media, explicit otherwise', () => {
    const media: Clip = {
      kind: 'media',
      id: 'c',
      mediaId: M1,
      sourceInSec: 2,
      sourceOutSec: 7,
      startSec: 0,
      effects: [],
    };
    const text: Clip = {
      kind: 'text',
      id: 't',
      text: 'hi',
      durationSec: 3,
      startSec: 0,
      effects: [],
      style: { fontSize: 48, color: 'white', background: null, anchor: 'center' },
    };
    expect(clipDuration(media)).toBe(5);
    expect(clipDuration(text)).toBe(3);
  });

  it('compositionDuration is the latest clip end across all tracks', () => {
    const comp = CompositionSchema.parse({
      version: 1,
      tracks: [
        {
          id: 'v0',
          kind: 'video',
          clips: [{ kind: 'media', id: 'a', mediaId: M1, sourceOutSec: 4, startSec: 0 }],
        },
        {
          id: 'v1',
          kind: 'video',
          clips: [{ kind: 'text', id: 'b', text: 'x', durationSec: 2, startSec: 10 }],
        },
      ],
    });
    expect(compositionDuration(comp)).toBe(12);
  });

  it('findClip locates a clip and its track', () => {
    const comp = CompositionSchema.parse({
      version: 1,
      tracks: [
        {
          id: 'v0',
          kind: 'video',
          clips: [{ kind: 'color', id: 'c', color: 'red', durationSec: 1, startSec: 0 }],
        },
      ],
    });
    const found = findClip(comp, 'c');
    expect(found?.track.id).toBe('v0');
    expect(found?.clip.id).toBe('c');
    expect(findClip(comp, 'nope')).toBeNull();
  });
});
