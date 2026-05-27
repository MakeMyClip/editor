import { z } from 'zod';
import { readSession } from '../session/store.js';

export const InspectInput = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Show only the last N ops. Omit to show all.'),
});

export type InspectInputType = z.infer<typeof InspectInput>;

export interface InspectedEntry {
  id: string;
  tool: string;
  timestamp: string;
  /** Compact one-line preview of this op for human/agent readability. */
  summary: string;
}

export interface InspectResult {
  totalOps: number;
  entries: InspectedEntry[];
}

function summarizeEntry(tool: string, args: Record<string, unknown>): string {
  // Pick the most useful field per tool. Falls back to "<tool> <input>" for
  // tools we don't have a dedicated summary for — still readable for agents.
  const input = typeof args.input === 'string' ? args.input : undefined;
  switch (tool) {
    case 'ingest':
      return `ingest ${args.path ?? input ?? ''}`;
    case 'trim':
      return `trim ${input ?? ''} ${args.start ?? ''}→${args.end ?? ''}`;
    case 'split':
      return `split ${input ?? ''} at ${args.atSec ?? ''}s`;
    case 'concat':
      return `concat ${Array.isArray(args.inputs) ? args.inputs.length : 0} clips`;
    case 'add_text':
      return `add_text "${String(args.text ?? '').slice(0, 30)}" ${args.startSec ?? ''}→${args.endSec ?? ''}s`;
    case 'add_audio':
      return `add_audio (${args.mode ?? 'mix'}) ${args.audio ?? ''}`;
    case 'transition':
      return `transition ${args.kind ?? 'fade'} ${args.inputA ?? ''}→${args.inputB ?? ''}`;
    case 'render':
      return `render ${input ?? ''} → ${args.format ?? 'mp4'}`;
    case 'preview':
      return `preview ${input ?? ''} @ ${args.atSec ?? ''}s`;
    case 'transform':
      return `transform ${args.op ?? ''} ${input ?? ''}`;
    case 'adjust':
      return `adjust ${Object.keys(args)
        .filter((k) => k !== 'input')
        .join('+')}`;
    case 'speed':
      return `speed ${input ?? ''} ×${args.factor ?? 1}${args.reverse ? ' reversed' : ''}`;
    case 'overlay':
      return `overlay ${args.overlay ?? ''} @ ${args.position ?? 'top-right'}`;
    case 'zoom_pan':
      return `zoom_pan ${args.fromZoom ?? 1}→${args.toZoom ?? 1.5}`;
    default:
      return `${tool} ${input ?? ''}`;
  }
}

export async function inspect(input: InspectInputType = {}): Promise<InspectResult> {
  const session = await readSession();
  const slice = input.limit ? session.entries.slice(-input.limit) : session.entries;
  return {
    totalOps: session.entries.length,
    entries: slice.map((e) => ({
      id: e.id,
      tool: e.tool,
      timestamp: e.timestamp,
      summary: summarizeEntry(e.tool, e.args),
    })),
  };
}
