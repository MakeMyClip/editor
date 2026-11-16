import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendOp } from '../src/session/store.js';
import { emptyComposition } from '../src/timeline/composition.js';
import {
  listTimelines,
  mutateComposition,
  readComposition,
  resetComposition,
} from '../src/timeline/document-store.js';
import { colorClip, mediaClip, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import { startUiServer, type UiServer } from '../src/ui/server.js';

// The `clip ui` routes for named timelines: every /api/timeline route takes
// `?timeline=`, and /api/timelines lists, deletes and exports shorts. None of
// these cases runs FFmpeg; the integration test renders the shorts.

let server: UiServer;
let workspace: string;
let savedWorkspace: string | undefined;

beforeAll(async () => {
  savedWorkspace = process.env.MAKEMYCLIP_WORKSPACE;
  server = await startUiServer({ openBrowser: false });
});

afterAll(async () => {
  await server.stop();
  if (savedWorkspace === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = savedWorkspace;
});

beforeEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = await mkdtemp(join(tmpdir(), 'mmc-ui-timelines-'));
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A 9:16 short holding one color clip, as make_short would leave it. */
async function makeShort(id: string): Promise<void> {
  await mutateComposition(
    [
      { op: 'setCanvas', width: 1080, height: 1920 },
      { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
      {
        op: 'addClip',
        trackId: 'v0',
        clip: colorClip({ id: 'c1', color: 'navy', durationSec: 2, startSec: 0 }),
      },
    ],
    { timeline: id, create: true },
  );
}

describe('?timeline= on the /api/timeline routes', () => {
  it('reads main by default and the named short otherwise', async () => {
    await makeShort('best-1');
    const main = await call('GET', '/api/timeline');
    const short = await call('GET', '/api/timeline?timeline=best-1');
    expect(main.status).toBe(200);
    expect((main.json.document as { width: number }).width).toBe(1920);
    expect((short.json.document as { width: number }).width).toBe(1080);
  });

  it('edits, undoes and reports history on the named short only', async () => {
    await makeShort('best-1');
    const mainRev = (await readComposition()).rev;

    const edit = await call('POST', '/api/timeline/verbs?timeline=best-1', {
      verbs: [{ verb: 'set_loudness', targetLufs: -16 }],
    });
    expect(edit.status).toBe(200);
    expect(edit.json.applied).toBe(1);
    expect(edit.json.warnings).toEqual([]);
    expect((await readComposition('best-1')).loudness).toEqual({ targetLufs: -16 });
    expect((await readComposition()).rev).toBe(mainRev);

    expect((await call('GET', '/api/timeline/history')).json).toEqual({
      canUndo: false,
      canRedo: false,
    });
    expect((await call('GET', '/api/timeline/history?timeline=best-1')).json.canUndo).toBe(true);

    expect((await call('POST', '/api/timeline/undo?timeline=best-1')).json.undone).toBe(true);
    expect((await readComposition('best-1')).loudness).not.toEqual({ targetLufs: -16 });
  });

  it('answers 400 for a malformed id and 404 for a short that does not exist', async () => {
    for (const path of [
      '/api/timeline?timeline=Best%201',
      '/api/timeline/history?timeline=..',
      '/api/timeline/exportable?timeline=a%2Fb',
    ]) {
      expect((await call('GET', path)).status, path).toBe(400);
    }
    for (const [method, path] of [
      ['GET', '/api/timeline?timeline=nope'],
      ['GET', '/api/timeline/history?timeline=nope'],
      ['GET', '/api/timeline/exportable?timeline=nope'],
      ['GET', '/api/timeline/frame?at=0&timeline=nope'],
      ['GET', '/api/timeline/transcript/c1?timeline=nope'],
      ['POST', '/api/timeline/undo?timeline=nope'],
      ['POST', '/api/timeline/redo?timeline=nope'],
      ['POST', '/api/timeline/export?timeline=nope'],
    ] as const) {
      const reply = await call(method, path, method === 'POST' ? {} : undefined);
      expect(reply.status, path).toBe(404);
      expect(reply.json.error, path).toContain('No timeline "nope"');
    }
    const edit = await call('POST', '/api/timeline/verbs?timeline=nope', {
      verbs: [{ verb: 'set_loudness', targetLufs: -16 }],
    });
    expect(edit.status).toBe(404);
    expect(await listTimelines()).toHaveLength(1);
  });
});

describe('/api/timelines', () => {
  it('lists main first, then every short with its shape', async () => {
    await makeShort('best-2');
    await makeShort('best-1');
    const { status, json } = await call('GET', '/api/timelines');
    expect(status).toBe(200);
    expect(json.timelines).toEqual([
      { id: 'main', width: 1920, height: 1080, durationSec: 0, rev: 0 },
      { id: 'best-1', width: 1080, height: 1920, durationSec: 2, rev: 1 },
      { id: 'best-2', width: 1080, height: 1920, durationSec: 2, rev: 1 },
    ]);
  });

  it('deletes a short, refuses main, and answers 404 for one that is gone', async () => {
    await makeShort('best-1');
    expect(await call('DELETE', '/api/timelines/best-1')).toEqual({
      status: 200,
      json: { deleted: 'best-1' },
    });
    expect((await listTimelines()).map((t) => t.id)).toEqual(['main']);
    expect((await call('DELETE', '/api/timelines/best-1')).status).toBe(404);

    const main = await call('DELETE', '/api/timelines/main');
    expect(main.status).toBe(400);
    expect(main.json.error).toContain("main timeline can't be deleted");
    expect((await call('DELETE', '/api/timelines/Not%20an%20id')).status).toBe(400);
  });

  it('refuses to export when there are no shorts', async () => {
    const reply = await call('POST', '/api/timelines/export', {});
    expect(reply.status).toBe(422);
    expect(reply.json.error).toContain('No shorts to export yet');
  });

  it('reports a short that cannot render, without logging it as an output', async () => {
    await resetComposition(emptyComposition({ width: 1080, height: 1920 }), 'best-1');
    const reply = await call('POST', '/api/timelines/export', {});
    expect(reply.status).toBe(200);
    expect(reply.json.dir).toMatch(/shorts-[0-9a-f]{8}$/);
    expect(reply.json.exported).toEqual([
      { timeline: 'best-1', error: 'Nothing to export: no video track has clips.' },
    ]);
    const session = await call('GET', '/api/session');
    expect(session.json.entries).toEqual([]);
  });

  it('refuses a short whose media was swapped for a link out of the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mmc-ui-outside-'));
    try {
      await writeFile(join(outside, 'private.mp4'), 'not for the export');
      const linked = join(workspace, 'talk.mp4');
      await symlink(join(outside, 'private.mp4'), linked);
      await appendOp({
        tool: 'ingest',
        args: { path: linked },
        result: { mediaId: 'm_0123456789ab', ref: { path: linked, audio: null, video: null } },
      });
      await mutateComposition(
        [
          { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
          {
            op: 'addClip',
            trackId: 'v0',
            clip: mediaClip({
              id: 'c1',
              mediaId: 'm_0123456789ab' as MediaId,
              sourceOutSec: 2,
              startSec: 0,
            }),
          },
        ],
        { timeline: 'best-1', create: true },
      );
      const reply = await call('POST', '/api/timelines/export', {});
      expect(reply.json.exported).toEqual([
        { timeline: 'best-1', error: expect.stringContaining('outside the workspace') },
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
