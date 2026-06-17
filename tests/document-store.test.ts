import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyComposition } from '../src/timeline/composition.js';
import {
  CompositionConflictError,
  CompositionCorruptError,
  compositionPath,
  mutateComposition,
  overwriteComposition,
  readComposition,
  resetComposition,
  writeComposition,
  writeCompositionIfUnchanged,
} from '../src/timeline/document-store.js';
import { mediaClip, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';

const M1 = 'm_aaaaaaaaaaaa' as MediaId;

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-doc-test-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

describe('document-store', () => {
  it('returns an empty composition when none exists', async () => {
    const comp = await readComposition();
    expect(comp.tracks).toEqual([]);
    expect(comp.version).toBe(1);
  });

  it('persists and reloads via mutateComposition (ops applied in order)', async () => {
    await resetComposition(emptyComposition({ fps: 60 }));
    await mutateComposition([
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: mediaClip({ id: 'c1', mediaId: M1, sourceOutSec: 4, startSec: 0 }),
      },
    ]);
    const reread = await readComposition();
    expect(reread.fps).toBe(60);
    expect(reread.tracks[0]?.clips[0]?.id).toBe('c1');
  });

  it('writes atomically — no temp files beside composition.json', async () => {
    await writeComposition(emptyComposition());
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(workspace);
    expect(files).toContain('composition.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('surfaces a corrupt composition file instead of silently resetting', async () => {
    await writeFile(compositionPath(), 'not valid json');
    await expect(readComposition()).rejects.toBeInstanceOf(CompositionCorruptError);
  });

  it('round-trips a written composition byte-stably through the schema', async () => {
    const comp = await mutateComposition([{ op: 'setCanvas', width: 1080, height: 1920 }]);
    const onDisk = JSON.parse(await readFile(compositionPath(), 'utf-8'));
    expect(onDisk).toEqual(comp);
  });
});

describe('optimistic concurrency (rev)', () => {
  it('loads a rev-less legacy composition as rev 0 (back-compat)', async () => {
    // Documents written before `rev` existed must still parse.
    await writeFile(compositionPath(), JSON.stringify({ version: 1, tracks: [] }));
    expect((await readComposition()).rev).toBe(0);
  });

  it('bumps rev monotonically and persists it across mutations', async () => {
    expect((await readComposition()).rev).toBe(0);
    await mutateComposition([{ op: 'setCanvas', width: 1280 }]);
    expect((await readComposition()).rev).toBe(1);
    await mutateComposition([{ op: 'setCanvas', height: 720 }]);
    expect((await readComposition()).rev).toBe(2);
  });

  it('writeCompositionIfUnchanged commits and bumps rev when the base is current', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]); // rev 1
    const current = await readComposition();
    const next = await writeCompositionIfUnchanged(current, current.rev);
    expect(next.rev).toBe(current.rev + 1);
    expect((await readComposition()).rev).toBe(current.rev + 1);
  });

  it('rejects a stale CAS write whose base rev was superseded, without clobbering', async () => {
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]); // rev 1
    const stale = await readComposition(); // captured at rev 1
    await mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v1' }) }]); // winner → rev 2

    await expect(writeCompositionIfUnchanged(stale, stale.rev)).rejects.toBeInstanceOf(
      CompositionConflictError,
    );
    // The winner survived; the rejected write did not overwrite it.
    const final = await readComposition();
    expect(final.rev).toBe(2);
    expect(final.tracks.map((t) => t.id)).toEqual(['v0', 'v1']);
  });

  it('serializes concurrent in-process mutations — no lost update', async () => {
    // The lost-update bug the CAS store fixes: a lock-free read-apply-write let
    // two concurrent callers clobber each other. Both ops must land, rev = 2.
    await Promise.all([
      mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]),
      mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'v1' }) }]),
    ]);
    const comp = await readComposition();
    expect(comp.rev).toBe(2);
    expect(new Set(comp.tracks.map((t) => t.id))).toEqual(new Set(['v0', 'v1']));
  });
});

describe('overwriteComposition (recovery primitive)', () => {
  it('replaces composition.json WITHOUT parsing it, even when corrupt', async () => {
    await mutateComposition([{ op: 'setCanvas', width: 1280 }]); // rev 1
    await writeFile(compositionPath(), 'not valid json'); // live doc now corrupt
    await expect(readComposition()).rejects.toBeInstanceOf(CompositionCorruptError);

    const next = await overwriteComposition(emptyComposition({ fps: 24 }));
    expect(next.rev).toBe(1); // corrupt base → rev 0 → 1
    expect(next.fps).toBe(24);

    const reread = await readComposition();
    expect(reread.fps).toBe(24);
    expect(reread.rev).toBe(1);
  });
});
