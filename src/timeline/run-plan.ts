import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { filterGraphFileOption, requireDrawtext, runFfmpeg } from '../ffmpeg/run.js';
import type { FfmpegPlan } from './compile.js';

export interface RunPlanResult {
  output: string;
  steps: number;
  durationMs: number;
}

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
    return { output: plan.output, steps: plan.steps.length, durationMs: Date.now() - start };
  } finally {
    for (const path of cleanup) {
      await unlink(path).catch(() => undefined);
    }
  }
}
