import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyComposition } from '../src/timeline/composition.js';
import {
  CompositionCorruptError,
  compositionPath,
  mutateComposition,
  readComposition,
  resetComposition,
  writeComposition,
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
