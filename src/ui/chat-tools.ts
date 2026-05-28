import { type Tool, tool } from 'ai';
import { appendOp } from '../session/store.js';
import { TOOL_REGISTRY } from './tool-registry.js';

/**
 * One-line descriptions surfaced to the agent for each tool. These are
 * what the model reads when deciding which tool to call — keep them
 * actionable and free of UI-speak. The full Zod schema (with per-field
 * `.describe()` text) gives the agent the parameter-level details.
 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  ingest: 'Probe and register a media file so other tools can reference it by path.',
  trim: 'Cut a clip between two timecodes (HH:MM:SS, MM:SS, or seconds). Stream-copy, no re-encode.',
  split: 'Divide a clip at a timecode into before + after halves.',
  concat: 'Stitch two or more video files back-to-back in order.',
  add_text: 'Burn a text overlay at a position for a time range.',
  add_audio:
    'Add or mix music / voiceover / sfx into a video — optional fade and sidechain ducking.',
  add_title_card: 'Prepend a colored card with centered text to a clip.',
  add_captions: 'Burn multiple timed caption cues into a video.',
  transition: 'Crossfade, slide, or wipe between two clips of matching dimensions.',
  render: 'Re-encode to mp4 / mov / webm with quality + size controls.',
  preview: 'Extract a single JPEG frame at a timecode (for the agent to inspect).',
  adjust: 'Adjust brightness, contrast, saturation, and/or audio volume in one pass.',
  speed: 'Slow down, speed up, or reverse a clip (audio stays in sync).',
  overlay: 'Picture-in-picture an overlay clip onto a base clip at a position.',
  zoom_pan: 'Ken Burns zoom / pan over a clip — animate scale and focus point.',
  stabilize: 'Two-pass vidstab stabilization. Requires an ffmpeg build with vidstab.',
  chroma_key: 'Key out a flat color from the foreground and composite over a background.',
  silence_remove: 'Detect and cut silent stretches from audio in a video.',
  highlight_reel:
    'Extract several time ranges from one source and stitch them with optional transitions.',
};

/**
 * Build the set of tools the chat-side agent can call. Each tool wraps a
 * `TOOL_REGISTRY` entry: validates with the Zod schema, runs the handler,
 * appends a session entry so agent-driven changes show up in session.json
 * exactly like UI-driven ones. The UI's session poll picks them up.
 *
 * Errors are returned as structured objects rather than thrown — the agent
 * can read a tool failure and try a different approach (e.g. fix arguments)
 * instead of the whole turn aborting.
 */
export function buildChatTools(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const [name, entry] of Object.entries(TOOL_REGISTRY)) {
    const description = TOOL_DESCRIPTIONS[name] ?? `Run the ${name} editor tool.`;
    tools[name] = tool({
      description,
      // The registry stores `z.ZodType<any>` to be heterogeneous-friendly;
      // AI SDK takes any Standard Schema (which Zod implements).
      // biome-ignore lint/suspicious/noExplicitAny: same any-on-purpose as TOOL_REGISTRY
      inputSchema: entry.schema as any,
      execute: async (input: unknown) => {
        try {
          const result = await entry.fn(input);
          await appendOp({
            tool: name,
            args: input as Record<string, unknown>,
            result: result as Record<string, unknown>,
          });
          return result;
        } catch (err) {
          // Return-as-data so the model can react. Throwing would abort
          // the whole streaming turn.
          const message = err instanceof Error ? err.message : String(err);
          return { error: message, tool: name };
        }
      },
    });
  }
  return tools;
}
