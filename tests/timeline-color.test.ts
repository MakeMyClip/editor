import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTimeline } from '../src/cli-timeline.js';
import { ColorSchema, isColor } from '../src/timeline/color.js';
import {
  type CompileContext,
  CompileError,
  checkExportable,
  compileTimeline,
} from '../src/timeline/compile.js';
import { type Composition, emptyComposition } from '../src/timeline/composition.js';
import { readComposition } from '../src/timeline/document-store.js';
import { applyOps, colorClip, mediaClip, videoTrack } from '../src/timeline/ops.js';
import type { MediaId } from '../src/timeline/schema.js';
import { CompositionVerbSchema, EditableVerbSchema } from '../src/timeline/verbs.js';

const M1 = 'm_aaaaaaaaaaaa' as MediaId;

/** Values that would add filters to the graph if they reached FFmpeg unquoted. */
const INJECTIONS = [
  'red,drawtext=text=x',
  'black[p];movie=/etc/passwd[m];[p][m]overlay',
  "black,metadata=mode=print:file=/tmp/x.txt:key='",
  'red:s=2x2',
  'red@0.5,null',
];

function ctx(): CompileContext {
  return {
    media: new Map([[M1, { path: '/ws/a.mp4', hasAudio: true }]]),
    dir: '/ws',
    output: '/ws/out.mp4',
  };
}

/** A stored document holding one clip, as a hand edit or an older version could write it. */
function docWith(
  clip: ReturnType<typeof colorClip> | ReturnType<typeof mediaClip>,
  background = 'black',
): Composition {
  return applyOps(emptyComposition({ background }), [
    { op: 'addTrack', track: videoTrack({ id: 'v0' }) },
    { op: 'addClip', trackId: 'v0', clip },
  ]);
}

const card = (color: string) => colorClip({ id: 'c1', color, durationSec: 2, startSec: 0 });
const media = () =>
  mediaClip({ id: 'm1', mediaId: M1, sourceInSec: 0, sourceOutSec: 2, startSec: 0 });

function stepArgs(comp: Composition): string[] {
  return compileTimeline(comp, ctx()).steps[0]?.args ?? [];
}

describe('isColor', () => {
  it('accepts FFmpeg color names in any case, hex, and an @alpha', () => {
    for (const value of [
      'black',
      'Red',
      'AliceBlue',
      '#ffcc00',
      '#FFCC0080',
      '0xffcc00',
      'ffcc00',
      'black@0.6',
      'white@1',
      'red@.5',
      '#ffcc00@0x80',
    ]) {
      expect(isColor(value), value).toBe(true);
    }
  });

  it('refuses filter syntax, unknown names and malformed hex or alpha', () => {
    for (const value of [
      ...INJECTIONS,
      '',
      ' red',
      'grey', // FFmpeg knows gray and lightgrey, not grey
      'notacolor',
      '#fff',
      '0XFFCC00',
      'red@1.5',
      'red@0x100',
      'red@',
      'red@@0.5',
      'rgb(255,0,0)',
    ]) {
      expect(isColor(value), value).toBe(false);
    }
  });

  it('refuses a long malformed alpha in linear time', () => {
    const start = performance.now();
    expect(isColor(`red@${'1'.repeat(100_000)}x`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('gives the schema a message naming the value and the forms that work', () => {
    const result = ColorSchema.safeParse('red,drawtext=text=x');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      '"red,drawtext=text=x" is not a color. Use a color name like black or white, or hex like #ffcc00, optionally with @0.5 for opacity.',
    );
  });
});

describe('add_color verb', () => {
  it('refuses a color that is not a color, for MCP clients and the UI alike', () => {
    for (const schema of [EditableVerbSchema, CompositionVerbSchema]) {
      for (const color of INJECTIONS) {
        const result = schema.safeParse({ verb: 'add_color', durationSec: 1, color });
        expect(result.success, color).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(['color']);
      }
    }
  });

  it('keeps hex, names and the default', () => {
    expect(
      EditableVerbSchema.parse({ verb: 'add_color', durationSec: 1, color: '#12ab34' }),
    ).toEqual({ verb: 'add_color', durationSec: 1, color: '#12ab34' });
    expect(
      EditableVerbSchema.parse({ verb: 'add_color', durationSec: 1, color: 'navy@0.5' }),
    ).toEqual({ verb: 'add_color', durationSec: 1, color: 'navy@0.5' });
    expect(EditableVerbSchema.parse({ verb: 'add_color', durationSec: 1 })).toEqual({
      verb: 'add_color',
      durationSec: 1,
    });
  });
});

describe('compileTimeline colors', () => {
  it('passes a valid card color and canvas background into the args, # as 0x', () => {
    const args = stepArgs(docWith(card('#12ab34'), 'Navy@0.5'));
    expect(args.slice(0, 5)).toEqual([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x12ab34:s=1920x1080:r=30',
    ]);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=Navy@0.5,setsar=1');
  });

  it('refuses a stored card color that is not a color', () => {
    for (const color of INJECTIONS) {
      expect(() => stepArgs(docWith(card(color))), color).toThrow(CompileError);
    }
    expect(() => stepArgs(docWith(card('red,drawtext=text=x')))).toThrow(
      'Color clip "c1" color "red,drawtext=text=x" is not a color.',
    );
  });

  it('refuses a stored canvas background that is not a color', () => {
    for (const background of INJECTIONS) {
      expect(() => stepArgs(docWith(media(), background)), background).toThrow(CompileError);
    }
    expect(() => stepArgs(docWith(media(), 'red,drawtext=text=x'))).toThrow(
      'Canvas background "red,drawtext=text=x" is not a color.',
    );
  });

  it('reports the bad color as an export blocker', () => {
    const report = checkExportable(docWith(card('red,null')), ctx().media, '/ws');
    expect(report.exportable).toBe(false);
    expect(report.blockers[0]).toMatch(/^Color clip "c1" color "red,null" is not a color\./);
  });
});

describe('clip timeline color flags', () => {
  let workspace: string;
  let saved: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'mmc-color-'));
    saved = process.env.MAKEMYCLIP_WORKSPACE;
    process.env.MAKEMYCLIP_WORKSPACE = workspace;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
    else process.env.MAKEMYCLIP_WORKSPACE = saved;
    await rm(workspace, { recursive: true, force: true });
  });

  it('new --background takes a color and refuses anything else before replacing the doc', async () => {
    await runTimeline(['new', '--background', '#102030']);
    expect((await readComposition()).background).toBe('#102030');

    await expect(
      runTimeline(['new', '--background', 'black[p];movie=/etc/passwd[m];[p][m]overlay']),
    ).rejects.toThrow('--background "black[p];movie=/etc/passwd[m];[p][m]overlay" is not a color.');
    expect((await readComposition()).background).toBe('#102030');
  });

  it('add-color --color takes a color and refuses anything else without adding a clip', async () => {
    await runTimeline(['new']);
    await runTimeline(['add-color', '1', '--color', 'papayawhip']);
    await expect(runTimeline(['add-color', '1', '--color', 'red,drawtext=text=x'])).rejects.toThrow(
      '--color "red,drawtext=text=x" is not a color.',
    );
    const clips = (await readComposition()).tracks.flatMap((t) => t.clips);
    expect(clips.map((c) => (c.kind === 'color' ? c.color : c.kind))).toEqual(['papayawhip']);
  });
});
