import { unlink, writeFile } from 'node:fs/promises';
import { runFfmpeg } from '../ffmpeg/run.js';
import type { FfmpegPlan } from './compile.js';

export interface RunPlanResult {
  output: string;
  steps: number;
  durationMs: number;
}

/**
 * Execute a compiled plan: write each step's text side-files, run the FFmpeg
 * steps in order, then clean up every intermediate segment and text file —
 * keeping only the final output. Cleanup runs even on failure so a botched
 * export doesn't litter the workspace.
 */
export async function runPlan(plan: FfmpegPlan): Promise<RunPlanResult> {
  const start = Date.now();
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
      await runFfmpeg(step.args);
    }
    return { output: plan.output, steps: plan.steps.length, durationMs: Date.now() - start };
  } finally {
    for (const path of cleanup) {
      await unlink(path).catch(() => undefined);
    }
  }
}
