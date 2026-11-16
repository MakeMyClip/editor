import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  buildLoudnormApplyArgs,
  buildLoudnormMeasureArgs,
  parseLoudnormJson,
} from '../ffmpeg/args/loudnorm.js';
import { filterGraphFileOption, requireDrawtext, runFfmpeg } from '../ffmpeg/run.js';
import { getWorkspace } from '../workspace.js';
import { compileTimeline, type FfmpegPlan, type MediaInfo } from './compile.js';
import type { Composition } from './composition.js';
import { readComposition } from './document-store.js';
import { buildMediaMap } from './media-registry.js';
import type { MediaId } from './schema.js';

export interface LoudnessResult {
  targetLufs: number;
  /** Integrated loudness before normalizing; null when silent or too short to measure. */
  inputLufs: number | null;
  /** Integrated loudness after, as loudnorm reports it; null when skipped. */
  outputLufs: number | null;
  /** True peak after, dBTP; null when skipped. */
  truePeakDb: number | null;
  /** `dynamic` when loudnorm couldn't apply one gain (see ffmpeg/args/loudnorm.ts);
   *  `skipped` when the audio was silent, near-silent or too short to measure. */
  mode: 'linear' | 'dynamic' | 'skipped';
}

export interface RunPlanResult {
  output: string;
  steps: number;
  durationMs: number;
  loudness?: LoudnessResult;
}

/** Quieter than this, an export is room tone at most: boosting it raises only noise. */
const NEAR_SILENT_LUFS = -50;

/** Longest filtergraph passed inline. Many captions make one long graph, and
 *  Windows caps a whole command line at 32 KiB (Linux one argument at 128 KiB). */
export const INLINE_GRAPH_MAX = 30_000;

/**
 * The step's args with an over-long `-filter_complex` graph moved to a file
 * read by `fileOption`, and the graph to write there; unchanged otherwise.
 */
export function spillLongGraph(
  args: string[],
  graphPath: string,
  fileOption: string,
): { args: string[]; graph: string | null } {
  const at = args.indexOf('-filter_complex');
  const graph = at === -1 ? undefined : args[at + 1];
  if (graph === undefined || graph.length <= INLINE_GRAPH_MAX) return { args, graph: null };
  const spilled = [...args];
  spilled.splice(at, 2, fileOption, graphPath);
  return { args: spilled, graph };
}

/**
 * Execute a compiled plan: write each step's text side-files, run the FFmpeg
 * steps in order, then clean up every intermediate segment and text file —
 * keeping only the final output. Cleanup runs even on failure so a botched
 * export doesn't litter the workspace.
 */
export async function runPlan(plan: FfmpegPlan): Promise<RunPlanResult> {
  const start = Date.now();
  // Only text segments carry text files; check before the first step renders.
  if (plan.steps.some((step) => step.textFiles.length > 0)) await requireDrawtext();
  const cleanup: string[] = [];
  try {
    for (const step of plan.steps) {
      for (const textFile of step.textFiles) {
        await writeFile(textFile.path, textFile.content, 'utf-8');
        cleanup.push(textFile.path);
      }
      // Register the intermediate BEFORE running so a step that fails after the
      // muxer opens its output (ffmpeg runs with -y) doesn't leak a partial file.
      if (step.output !== plan.output) cleanup.push(step.output);
      let { args } = step;
      if (step.args.some((a) => a.length > INLINE_GRAPH_MAX)) {
        // Beside the step's output: a folder the plan already writes to.
        const graphPath = join(
          dirname(step.output),
          `.graph-${randomBytes(4).toString('hex')}.txt`,
        );
        const spilled = spillLongGraph(step.args, graphPath, await filterGraphFileOption());
        if (spilled.graph !== null) {
          await writeFile(graphPath, spilled.graph, 'utf-8');
          cleanup.push(graphPath);
          args = spilled.args;
        }
      }
      await runFfmpeg(args);
    }
    const loudness = plan.loudness
      ? await normalizeLoudness(plan.output, plan.loudness.targetLufs, cleanup)
      : undefined;
    return {
      output: plan.output,
      steps: plan.steps.length,
      durationMs: Date.now() - start,
      ...(loudness ? { loudness } : {}),
    };
  } finally {
    for (const path of cleanup) {
      await unlink(path).catch(() => undefined);
    }
  }
}

/**
 * Measure the finished export, then rewrite it at the target loudness through a
 * temp file beside it (same folder and extension, so the rename stays on one
 * device and the container doesn't change). If this pass fails the export is
 * removed too, so a file at the original levels is never left looking done.
 */
async function normalizeLoudness(
  output: string,
  targetLufs: number,
  cleanup: string[],
): Promise<LoudnessResult> {
  try {
    const measure = await runFfmpeg(buildLoudnormMeasureArgs({ input: output, targetLufs }));
    const measured = parseLoudnormJson(measure.stderr);
    if (!measured || measured.inputI < NEAR_SILENT_LUFS) {
      return {
        targetLufs,
        inputLufs: measured?.inputI ?? null,
        outputLufs: null,
        truePeakDb: null,
        mode: 'skipped',
      };
    }
    const temp = join(
      dirname(output),
      `.loudnorm-${randomBytes(4).toString('hex')}${extname(output)}`,
    );
    cleanup.push(temp);
    const applied = await runFfmpeg(
      buildLoudnormApplyArgs({ input: output, output: temp, targetLufs, measured }),
    );
    await rename(temp, output);
    const after = parseLoudnormJson(applied.stderr);
    return {
      targetLufs,
      inputLufs: measured.inputI,
      outputLufs: after?.outputI ?? null,
      truePeakDb: after?.outputTp ?? null,
      mode: after?.mode ?? measured.mode,
    };
  } catch (err) {
    await unlink(output).catch(() => undefined);
    throw err;
  }
}

/** A timeline `exportTimelines` rendered, or why it couldn't. */
export type TimelineExport =
  | {
      timeline: string;
      rev: number;
      output: string;
      durationSec: number;
      durationMs: number;
      loudness?: LoudnessResult;
    }
  | { timeline: string; error: string };

/**
 * Render each timeline to `<dir>/<id>.mp4`, one at a time. A timeline that
 * can't render is reported with its error, and the rest still render. `media`
 * resolves each document's files (default: the registry as ingested); callers
 * acting for the UI pass one that re-checks them against the workspace.
 */
export async function exportTimelines(
  timelines: readonly string[],
  dir: string,
  media: (comp: Composition) => Promise<Map<MediaId, MediaInfo>> = () => buildMediaMap(),
): Promise<TimelineExport[]> {
  await mkdir(dir, { recursive: true });
  // Intermediates are named per run, so a concurrent export or frame preview
  // in the same workspace can't overwrite them.
  const run = randomBytes(4).toString('hex');
  const results: TimelineExport[] = [];
  for (const timeline of timelines) {
    try {
      const comp = await readComposition(timeline);
      const plan = compileTimeline(comp, {
        media: await media(comp),
        dir: getWorkspace(),
        output: join(dir, `${timeline}.mp4`),
        tag: `${run}-${timeline}`,
      });
      const result = await runPlan(plan);
      results.push({
        timeline,
        rev: comp.rev,
        output: result.output,
        durationSec: plan.durationSec,
        durationMs: result.durationMs,
        ...(result.loudness ? { loudness: result.loudness } : {}),
      });
    } catch (err) {
      results.push({ timeline, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
