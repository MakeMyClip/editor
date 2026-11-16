import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTimeline } from '../src/cli-timeline.js';
import { emptyComposition } from '../src/timeline/composition.js';
import { resetComposition } from '../src/timeline/document-store.js';
import { exportTimelines } from '../src/timeline/run-plan.js';

// `clip timeline export --all` and the `exportTimelines` it shares with the UI,
// on the paths that run no FFmpeg; tests/integration renders real shorts.

let workspace: string;
let saved: string | undefined;
let printed: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-export-all-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
  printed = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

describe('exportTimelines', () => {
  it('reports a timeline that cannot render and goes on to the next', async () => {
    await resetComposition(emptyComposition({ width: 1080, height: 1920 }), 'best-1');
    const results = await exportTimelines(['best-1', 'gone'], join(workspace, 'out'));
    expect(results).toEqual([
      { timeline: 'best-1', error: 'Nothing to export: no video track has clips.' },
      { timeline: 'gone', error: expect.stringContaining('No timeline "gone"') },
    ]);
  });
});

describe('clip timeline export --all', () => {
  it('exports every short but main, and fails the run when one cannot render', async () => {
    await resetComposition(emptyComposition({ width: 1080, height: 1920 }), 'best-1');
    await runTimeline(['export', '--all', join(workspace, 'shorts')]);
    expect(JSON.parse(printed)).toEqual({
      exported: [{ timeline: 'best-1', error: 'Nothing to export: no video track has clips.' }],
    });
    expect(process.exitCode).toBe(1);
  });

  it('needs a folder and at least one short', async () => {
    await expect(runTimeline(['export', '--all'])).rejects.toThrow(
      'Usage: clip timeline export --all <dir>',
    );
    await expect(runTimeline(['export', '--all', join(workspace, 'shorts')])).rejects.toThrow(
      'No shorts to export.',
    );
  });

  it('refuses --timeline and project formats, which export one timeline', async () => {
    await resetComposition(emptyComposition(), 'best-1');
    for (const extra of [
      ['--timeline', 'best-1'],
      ['--format', 'fcpxml'],
    ]) {
      await expect(runTimeline(['export', '--all', 'shorts', ...extra])).rejects.toThrow(
        '--all renders every short as mp4.',
      );
    }
  });
});
