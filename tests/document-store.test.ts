import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyComposition } from '../src/timeline/composition.js';
import {
  CompositionConflictError,
  CompositionCorruptError,
  compositionOpsPath,
  compositionPath,
  deleteTimeline,
  listTimelines,
  mutateComposition,
  NoTimelineError,
  overwriteComposition,
  readComposition,
  readDocOpLog,
  redoDocOp,
  resetComposition,
  TimelineIdError,
  undoLastDocOp,
  writeComposition,
  writeCompositionIfUnchanged,
} from '../src/timeline/document-store.js';
import { mediaClip, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import { WorkspaceBoundaryError } from '../src/workspace.js';

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

describe('named timelines', () => {
  it('keeps main at the workspace root and every other timeline in timelines/<id>/', () => {
    expect(compositionPath()).toBe(join(workspace, 'composition.json'));
    expect(compositionPath('main')).toBe(join(workspace, 'composition.json'));
    expect(compositionOpsPath('main')).toBe(join(workspace, 'composition-ops.json'));
    expect(compositionPath('best-1')).toBe(
      join(workspace, 'timelines', 'best-1', 'composition.json'),
    );
    expect(compositionOpsPath('best-1')).toBe(
      join(workspace, 'timelines', 'best-1', 'composition-ops.json'),
    );
  });

  it('refuses a malformed timeline id before touching a path', () => {
    for (const bad of ['../main', 'Best', '', '-x', 'a/b', 'x'.repeat(49)]) {
      expect(() => compositionPath(bad)).toThrow(TimelineIdError);
    }
  });

  it('throws NoTimelineError for a missing timeline other than main', async () => {
    await expect(readComposition('nope')).rejects.toBeInstanceOf(NoTimelineError);
    await expect(
      mutateComposition([{ op: 'setCanvas', width: 1280 }], { timeline: 'nope' }),
    ).rejects.toBeInstanceOf(NoTimelineError);
    await expect(undoLastDocOp('nope')).rejects.toBeInstanceOf(NoTimelineError);
    await expect(redoDocOp('nope')).rejects.toBeInstanceOf(NoTimelineError);
    await expect(readDocOpLog('nope')).rejects.toBeInstanceOf(NoTimelineError);
    await expect(writeCompositionIfUnchanged(emptyComposition(), 0, 'nope')).rejects.toBeInstanceOf(
      NoTimelineError,
    );
    expect((await readComposition('main')).tracks).toEqual([]);
  });

  it('creates a timeline with create or reset, then keeps its own rev and undo history', async () => {
    await mutateComposition([{ op: 'setCanvas', width: 1280 }]); // main rev 1
    await mutateComposition([{ op: 'setCanvas', height: 720 }]); // main rev 2

    const short = await mutateComposition([{ op: 'setCanvas', width: 1080, height: 1920 }], {
      timeline: 'best-1',
      create: true,
    });
    expect(short.rev).toBe(1);
    await resetComposition(emptyComposition({ fps: 24 }), 'best-2');
    expect((await readComposition('best-2')).fps).toBe(24);

    await mutateComposition([{ op: 'setCanvas', fps: 60 }], { timeline: 'best-1' });
    expect((await readComposition('best-1')).rev).toBe(2);
    expect((await readComposition()).rev).toBe(2);
    expect((await readDocOpLog('best-1')).entries).toHaveLength(2);

    await undoLastDocOp('best-1');
    expect((await readComposition('best-1')).fps).toBe(30);
    expect((await readComposition()).height).toBe(720);
    expect((await readDocOpLog()).cursor).toBe(2);
  });

  it('serializes writes per timeline, so concurrent edits of two timelines both land', async () => {
    await resetComposition(emptyComposition(), 'best-1');
    await Promise.all([
      mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'a' }) }], {
        timeline: 'best-1',
      }),
      mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'b' }) }], {
        timeline: 'best-1',
      }),
      mutateComposition([{ op: 'addTrack', track: videoTrack({ id: 'm' }) }]),
    ]);
    expect((await readComposition('best-1')).tracks.map((t) => t.id).sort()).toEqual(['a', 'b']);
    expect((await readComposition()).tracks.map((t) => t.id)).toEqual(['m']);
  });

  it('lists main first, then each timeline by id, and a corrupt one with its error', async () => {
    await resetComposition(emptyComposition({ width: 1080, height: 1920 }), 'zeta');
    await resetComposition(emptyComposition(), 'alpha');
    await resetComposition(emptyComposition(), 'broken');
    await writeFile(compositionPath('broken'), 'not json');
    await mkdir(join(workspace, 'timelines', 'empty-folder'), { recursive: true });
    await writeFile(join(workspace, 'timelines', 'stray.txt'), 'x');

    const listed = await listTimelines();
    expect(listed.map((t) => t.id)).toEqual(['main', 'alpha', 'broken', 'zeta']);
    expect(listed[0]).toEqual({ id: 'main', width: 1920, height: 1080, durationSec: 0, rev: 0 });
    expect(listed[3]).toMatchObject({ id: 'zeta', width: 1080, height: 1920, rev: 1 });
    expect(listed[2]).toMatchObject({ id: 'broken', error: expect.stringMatching(/corrupt/) });
  });

  it('deletes a timeline, refuses main, and reports a missing one', async () => {
    await resetComposition(emptyComposition(), 'best-1');
    await deleteTimeline('best-1');
    await expect(readComposition('best-1')).rejects.toBeInstanceOf(NoTimelineError);
    expect((await listTimelines()).map((t) => t.id)).toEqual(['main']);

    await expect(deleteTimeline('best-1')).rejects.toBeInstanceOf(NoTimelineError);
    await expect(deleteTimeline('main')).rejects.toBeInstanceOf(TimelineIdError);
  });

  it('deletes a corrupt timeline', async () => {
    await resetComposition(emptyComposition(), 'broken');
    await writeFile(compositionPath('broken'), 'not json');
    await deleteTimeline('broken');
    expect((await listTimelines()).map((t) => t.id)).toEqual(['main']);
  });

  it('refuses a timeline folder out of the workspace even when its files link back in', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mmc-outside-'));
    try {
      // timelines/ leads out; the files in it link back to documents inside.
      const kept = join(workspace, 'kept');
      await mkdir(kept);
      await writeFile(join(kept, 'composition.json'), JSON.stringify(emptyComposition()));
      await writeFile(join(kept, 'composition-ops.json'), '{}');
      await mkdir(join(outside, 'best-1'));
      for (const file of ['composition.json', 'composition-ops.json']) {
        await symlink(join(kept, file), join(outside, 'best-1', file));
      }
      await symlink(outside, join(workspace, 'timelines'));

      await expect(readComposition('best-1')).rejects.toBeInstanceOf(WorkspaceBoundaryError);
      await expect(
        mutateComposition([{ op: 'setCanvas', width: 2 }], { timeline: 'best-1' }),
      ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
      await expect(deleteTimeline('best-1')).rejects.toBeInstanceOf(WorkspaceBoundaryError);
      const { readdir } = await import('node:fs/promises');
      expect((await readdir(join(outside, 'best-1'))).sort()).toEqual([
        'composition-ops.json',
        'composition.json',
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a timelines/ folder that is a symlink out of the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mmc-outside-'));
    try {
      await mkdir(join(outside, 'best-1'));
      await writeFile(
        join(outside, 'best-1', 'composition.json'),
        JSON.stringify(emptyComposition()),
      );
      await symlink(outside, join(workspace, 'timelines'));
      await expect(readComposition('best-1')).rejects.toBeInstanceOf(WorkspaceBoundaryError);
      await expect(
        mutateComposition([{ op: 'setCanvas', width: 2 }], { timeline: 'best-2', create: true }),
      ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
      await expect(listTimelines()).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
