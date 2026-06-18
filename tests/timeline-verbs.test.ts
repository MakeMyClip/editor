import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyComposition } from '../src/timeline/composition.js';
import {
  applyVerbs,
  CompositionConflictError,
  mutateComposition,
  readComposition,
  readDocOpLog,
  undoLastDocOp,
} from '../src/timeline/document-store.js';
import { applyOps, type CompositionOp, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import { lowerVerb, lowerVerbs, type VerbContext } from '../src/timeline/verbs.js';

const M = 'm_aaaaaaaaaaaa' as MediaId;
const ctx = (durationSec = 10): VerbContext => ({
  ingest: async () => ({ mediaId: M, durationSec }),
  defaultTrack: 'v0',
});

type AddClipOp = Extract<CompositionOp, { op: 'addClip' }>;
const addClips = (ops: CompositionOp[]): AddClipOp[] =>
  ops.filter((o): o is AddClipOp => o.op === 'addClip');

describe('lowerVerb', () => {
  const empty = emptyComposition();

  it('add_media ingests, creates the default track, and appends a media clip', async () => {
    const ops = await lowerVerb(empty, { verb: 'add_media', path: '/a.mp4' }, ctx());
    expect(ops).toMatchObject([
      { op: 'addTrack', track: { id: 'v0' } },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: { kind: 'media', mediaId: M, sourceInSec: 0, sourceOutSec: 10, startSec: 0 },
      },
    ]);
  });

  it('add_media honors explicit start/trim/track and skips addTrack when it exists', async () => {
    const doc = applyOps(empty, [{ op: 'addTrack', track: videoTrack({ id: 'v0' }) }]);
    const ops = await lowerVerb(
      doc,
      {
        verb: 'add_media',
        path: '/a.mp4',
        track: 'v0',
        startSec: 5,
        sourceInSec: 1,
        sourceOutSec: 4,
      },
      ctx(),
    );
    expect(ops).toMatchObject([
      { op: 'addClip', clip: { sourceInSec: 1, sourceOutSec: 4, startSec: 5 } },
    ]);
    expect(ops.some((o) => o.op === 'addTrack')).toBe(false);
  });

  it('add_text lowers style and appends after the last clip by default', async () => {
    const ops = await lowerVerb(
      empty,
      { verb: 'add_text', text: 'hi', durationSec: 3, color: 'red' },
      ctx(),
    );
    expect(ops).toMatchObject([
      { op: 'addTrack', track: { id: 'v0' } },
      {
        op: 'addClip',
        clip: { kind: 'text', text: 'hi', durationSec: 3, style: { color: 'red' } },
      },
    ]);
  });

  it('edit verbs lower 1:1 to ops', async () => {
    expect(
      await lowerVerb(
        empty,
        { verb: 'trim', clipId: 'c1', sourceInSec: 1, sourceOutSec: 3 },
        ctx(),
      ),
    ).toEqual([{ op: 'setTrim', clipId: 'c1', sourceInSec: 1, sourceOutSec: 3 }]);
    expect(
      await lowerVerb(empty, { verb: 'move', clipId: 'c1', startSec: 2, toTrack: 'v1' }, ctx()),
    ).toEqual([{ op: 'moveClip', clipId: 'c1', startSec: 2, toTrackId: 'v1' }]);
    expect(await lowerVerb(empty, { verb: 'remove', clipId: 'c1' }, ctx())).toEqual([
      { op: 'removeClip', clipId: 'c1' },
    ]);
    expect(await lowerVerb(empty, { verb: 'transition', afterClipId: 'c1' }, ctx())).toEqual([
      {
        op: 'addTransition',
        trackId: 'v0',
        transition: { afterClipId: 'c1', kind: 'fade', durationSec: 1 },
      },
    ]);
    expect(
      await lowerVerb(
        empty,
        { verb: 'set_transform', clipId: 'c1', scale: 2, opacity: 0.5 },
        ctx(),
      ),
    ).toEqual([{ op: 'setTransform', clipId: 'c1', transform: { scale: 2, opacity: 0.5 } }]);
    const split = await lowerVerb(empty, { verb: 'split', clipId: 'c1', atSec: 2 }, ctx());
    expect(split[0]).toMatchObject({ op: 'splitClip', clipId: 'c1', atSec: 2 });
  });
});

describe('lowerVerbs (state threads between verbs)', () => {
  it('the default append point shifts as earlier verbs add clips', async () => {
    const ops = await lowerVerbs(
      emptyComposition(),
      [
        { verb: 'add_media', path: '/a.mp4' }, // [0,5)
        { verb: 'add_color', durationSec: 2 }, // should append at 5
      ],
      ctx(5),
    );
    const color = addClips(ops).find((o) => o.clip.kind === 'color');
    expect(color?.clip.startSec).toBe(5);
  });
});

describe('intent-free verbs lower to no ops (no spurious undo entry)', () => {
  it('trim/move with no value fields, and an empty set_transform, return []', async () => {
    const c = ctx();
    expect(await lowerVerb(emptyComposition(), { verb: 'trim', clipId: 'c1' }, c)).toEqual([]);
    expect(await lowerVerb(emptyComposition(), { verb: 'move', clipId: 'c1' }, c)).toEqual([]);
    expect(await lowerVerb(emptyComposition(), { verb: 'set_transform', clipId: 'c1' }, c)).toEqual(
      [],
    );
  });
});

describe('optional clip id (mid-batch references)', () => {
  it('add_* honor a caller-supplied id so a later verb in the batch can target it', async () => {
    const ops = await lowerVerbs(
      emptyComposition(),
      [
        { verb: 'add_color', id: 'card', durationSec: 2 },
        { verb: 'set_transform', clipId: 'card', opacity: 0.5 },
      ],
      ctx(),
    );
    expect(addClips(ops)[0]?.clip.id).toBe('card');
    expect(ops.some((o) => o.op === 'setTransform' && o.clipId === 'card')).toBe(true);
  });
});

describe('applyVerbs (op-aware + undoable)', () => {
  let workspace: string;
  let saved: string | undefined;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'mmc-verbs-test-'));
    saved = process.env.MAKEMYCLIP_WORKSPACE;
    process.env.MAKEMYCLIP_WORKSPACE = workspace;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
    else process.env.MAKEMYCLIP_WORKSPACE = saved;
    await rm(workspace, { recursive: true, force: true });
  });

  it('applies verbs through mutateComposition and records ONE undoable entry', async () => {
    const { doc, ops } = await applyVerbs([{ verb: 'add_media', path: '/a.mp4' }], ctx(6));
    expect(doc.tracks[0]?.clips[0]?.kind).toBe('media');
    expect(ops.length).toBeGreaterThan(0);

    const log = await readDocOpLog();
    expect(log.entries).toHaveLength(1);

    const undo = await undoLastDocOp();
    expect(undo.undone).toBe(true);
    expect((await readComposition()).tracks).toEqual([]);
  });

  it('mutateComposition rejects a stale expectedBaseRev (the guard applyVerbs retries on)', async () => {
    await mutateComposition([{ op: 'setCanvas', width: 1280 }]); // rev 1
    await expect(
      mutateComposition([{ op: 'setCanvas', height: 720 }], { expectedBaseRev: 0 }),
    ).rejects.toBeInstanceOf(CompositionConflictError);
    const doc = await mutateComposition([{ op: 'setCanvas', height: 720 }], { expectedBaseRev: 1 });
    expect(doc.rev).toBe(2);
  });
});
