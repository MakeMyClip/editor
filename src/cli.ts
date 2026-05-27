#!/usr/bin/env node
import { appendOp } from './session/store.js';
import { addAudio } from './tools/add-audio.js';
import { addCaptions } from './tools/add-captions.js';
import { addText } from './tools/add-text.js';
import { addTitleCard } from './tools/add-title-card.js';
import { adjust } from './tools/adjust.js';
import { chromaKey } from './tools/chroma-key.js';
import { concat } from './tools/concat.js';
import { deleteOp } from './tools/delete-op.js';
import { highlightReel } from './tools/highlight-reel.js';
import { ingest } from './tools/ingest.js';
import { inspect } from './tools/inspect.js';
import { overlay } from './tools/overlay.js';
import { preview } from './tools/preview.js';
import { render } from './tools/render.js';
import { silenceRemove } from './tools/silence-remove.js';
import { snapshot } from './tools/snapshot.js';
import { speed } from './tools/speed.js';
import { split } from './tools/split.js';
import { stabilize } from './tools/stabilize.js';
import { type TransformResult, transform } from './tools/transform.js';
import { transition } from './tools/transition.js';
import { trim } from './tools/trim.js';
import { undo } from './tools/undo.js';
import { zoomPan } from './tools/zoom-pan.js';
import { startUiServer } from './ui/server.js';

const HELP = `clip — MakeMyClip Editor

Editing tools (every successful invocation is logged to session.json):
  clip ingest <input>
  clip trim <input> <start> <end>
  clip split <input> <atSec>
  clip concat <input1> <input2> [<input3> ...]
  clip add_text <input> <text> <position> <startSec> <endSec>
  clip add_audio <input> <audio> [<mode>] [<audioVolume>] [<startSec>]
  clip preview <input> <atSec>
  clip transition <inputA> <inputB> [<kind>] [<durationSec>]
  clip render <input> [<format>] [<crf>] [<preset>] [<maxWidth>]
  clip transform <op> <input> [<op-args>...]
  clip adjust <input> [--brightness N] [--contrast N] [--saturation N] [--volume N]
  clip speed <input> [<factor>] [<reverse>]
  clip overlay <base> <overlay> [<position>] [<scaleToWidth>] [<startSec>] [<endSec>]
  clip zoom_pan <input> [<fromZoom>] [<toZoom>] [<centerX>] [<centerY>]

Composites:
  clip add_title_card <input> <text> [<durationSec>] [<background>] [<fontSize>] [<fontColor>]
  clip add_captions <input> <cuesJson>
      cuesJson = JSON array of { text, startSec, endSec, position? }
  clip silence_remove <input> [<noiseDb>] [<minSilenceSec>]
  clip highlight_reel <input> <segmentsJson> [<transitionKind>] [<transitionSec>]
      segmentsJson = JSON array of { startSec, endSec }

Specialty:
  clip chroma_key <foreground> <background> [<color>] [<similarity>] [<blend>]
      Key out a color (default green) and composite over the background.
      Background can be a video or a still image (auto-detected, looped).
  clip stabilize <input> [<shakiness>] [<smoothing>] [<accuracy>] [<zoom>]
      Two-pass vidstab. Defaults: shakiness=5, smoothing=10, accuracy=9, zoom=5.

UI:
  clip ui                           Start the local browser UI on http://127.0.0.1:5573.
                                    Renders the session log; click an op to play its output.

Session safety (these tools do not log themselves):
  clip snapshot [<label>]           Save the current session as a named snapshot.
  clip undo [<snapshotLabel>]       Pop the last op, or restore a named snapshot.
  clip inspect [<limit>]            Show recent ops with one-line summaries.
  clip delete <id> [<removeFile>]   Remove an op from the session log.
                                    removeFile = 'true' also unlinks the output file.

  clip --help                       Show this help.
`;

/**
 * Wrap a tool call so its (args, result) are appended to the session log on
 * success. Session-management tools (snapshot/undo/inspect/delete) skip this
 * wrapper — they shouldn't log themselves and create confusing recursion.
 */
async function runAndLog<T>(
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await fn();
  await appendOp({
    tool,
    args,
    // Tool result types are interfaces, not Record<string, unknown> — cast at
    // the boundary because the session log treats results as opaque JSON.
    result: result as unknown as Record<string, unknown>,
  });
  return result;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (command === 'ingest') {
    const [input] = args;
    if (!input) {
      process.stderr.write('Usage: clip ingest <input>\n');
      process.exit(1);
    }
    const result = await runAndLog('ingest', { path: input }, () => ingest({ path: input }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'trim') {
    const [input, start, end] = args;
    if (!input || !start || !end) {
      process.stderr.write('Usage: clip trim <input> <start> <end>\n');
      process.exit(1);
    }
    const result = await runAndLog('trim', { input, start, end }, () =>
      trim({ input, start, end }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'split') {
    const [input, atSec] = args;
    if (!input || atSec === undefined) {
      process.stderr.write('Usage: clip split <input> <atSec>\n');
      process.exit(1);
    }
    const result = await runAndLog('split', { input, atSec: Number(atSec) }, () =>
      split({ input, atSec: Number(atSec) }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'concat') {
    if (args.length < 2) {
      process.stderr.write('Usage: clip concat <input1> <input2> [<input3> ...]\n');
      process.exit(1);
    }
    const result = await runAndLog('concat', { inputs: args }, () => concat({ inputs: args }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'preview') {
    const [input, atSec] = args;
    if (!input || atSec === undefined) {
      process.stderr.write('Usage: clip preview <input> <atSec>\n');
      process.exit(1);
    }
    const result = await runAndLog('preview', { input, atSec: Number(atSec) }, () =>
      preview({ input, atSec: Number(atSec) }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'render') {
    const [input, format, crf, preset, maxWidth] = args;
    if (!input) {
      process.stderr.write(
        'Usage: clip render <input> [<format>] [<crf>] [<preset>] [<maxWidth>]\n',
      );
      process.exit(1);
    }
    const renderArgs = {
      input,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      format: (format as any) ?? undefined,
      crf: crf ? Number(crf) : undefined,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      preset: (preset as any) ?? undefined,
      maxWidth: maxWidth ? Number(maxWidth) : undefined,
    };
    const result = await runAndLog('render', renderArgs, () => render(renderArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'transition') {
    const [inputA, inputB, kind, durationSec] = args;
    if (!inputA || !inputB) {
      process.stderr.write('Usage: clip transition <inputA> <inputB> [<kind>] [<durationSec>]\n');
      process.exit(1);
    }
    const transitionArgs = {
      inputA,
      inputB,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates the value at runtime
      kind: (kind as any) ?? undefined,
      durationSec: durationSec ? Number(durationSec) : undefined,
    };
    const result = await runAndLog('transition', transitionArgs, () => transition(transitionArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'add_audio') {
    const [input, audio, mode, audioVolume, startSec] = args;
    if (!input || !audio) {
      process.stderr.write(
        'Usage: clip add_audio <input> <audio> [<mode>] [<audioVolume>] [<startSec>]\n',
      );
      process.exit(1);
    }
    const addAudioArgs = {
      input,
      audio,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      mode: (mode as any) ?? undefined,
      audioVolume: audioVolume ? Number(audioVolume) : undefined,
      startSec: startSec ? Number(startSec) : undefined,
    };
    const result = await runAndLog('add_audio', addAudioArgs, () => addAudio(addAudioArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'add_text') {
    const [input, text, position, startSec, endSec] = args;
    if (!input || !text || !position || !startSec || !endSec) {
      process.stderr.write('Usage: clip add_text <input> <text> <position> <startSec> <endSec>\n');
      process.exit(1);
    }
    const addTextArgs = {
      input,
      text,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      position: position as any,
      startSec: Number(startSec),
      endSec: Number(endSec),
    };
    const result = await runAndLog('add_text', addTextArgs, () => addText(addTextArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'transform') {
    const [op, input, ...rest] = args;
    if (!op || !input) {
      process.stderr.write(
        'Usage: clip transform <crop|rotate|flip|scale> <input> [<op-args>...]\n',
      );
      process.exit(1);
    }
    let result: TransformResult;
    let loggedArgs: Record<string, unknown>;
    if (op === 'crop') {
      const [x, y, width, height] = rest;
      if (!x || !y || !width || !height) {
        process.stderr.write('Usage: clip transform crop <input> <x> <y> <width> <height>\n');
        process.exit(1);
      }
      const cropArgs = {
        op: 'crop' as const,
        input,
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      };
      loggedArgs = cropArgs;
      result = await transform(cropArgs);
    } else if (op === 'rotate') {
      const [degrees] = rest;
      const d = Number(degrees);
      if (d !== 90 && d !== 180 && d !== 270) {
        process.stderr.write('rotate degrees must be 90, 180, or 270\n');
        process.exit(1);
      }
      const rotateArgs = {
        op: 'rotate' as const,
        input,
        degrees: d as 90 | 180 | 270,
      };
      loggedArgs = rotateArgs;
      result = await transform(rotateArgs);
    } else if (op === 'flip') {
      const [axis] = rest;
      if (axis !== 'horizontal' && axis !== 'vertical') {
        process.stderr.write('Usage: clip transform flip <input> <horizontal|vertical>\n');
        process.exit(1);
      }
      // TS narrowing through `process.exit` is fine in isolation, but the
      // object-literal capture below sometimes widens it back to string.
      // Explicit cast keeps the call-site clean.
      const flipArgs = { op: 'flip' as const, input, axis: axis as 'horizontal' | 'vertical' };
      loggedArgs = flipArgs;
      result = await transform(flipArgs);
    } else if (op === 'scale') {
      const [width, height] = rest;
      const scaleArgs = {
        op: 'scale' as const,
        input,
        width: width ? Number(width) : undefined,
        height: height ? Number(height) : undefined,
      };
      loggedArgs = scaleArgs;
      result = await transform(scaleArgs);
    } else {
      process.stderr.write(`Unknown transform op: ${op} (expected crop|rotate|flip|scale)\n`);
      process.exit(1);
    }
    // TransformResult is an interface; cast to a Record for the opaque
    // session-log shape.
    await appendOp({
      tool: 'transform',
      args: loggedArgs,
      result: result as unknown as Record<string, unknown>,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'adjust') {
    const [input, ...rest] = args;
    if (!input) {
      process.stderr.write(
        'Usage: clip adjust <input> [--brightness N] [--contrast N] [--saturation N] [--volume N]\n',
      );
      process.exit(1);
    }
    const flags: Record<string, number> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (flag?.startsWith('--') && value !== undefined) {
        flags[flag.slice(2)] = Number(value);
      }
    }
    const adjustArgs = {
      input,
      brightness: flags.brightness,
      contrast: flags.contrast,
      saturation: flags.saturation,
      volume: flags.volume,
    };
    const result = await runAndLog('adjust', adjustArgs, () => adjust(adjustArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'speed') {
    const [input, factor, reverse] = args;
    if (!input) {
      process.stderr.write('Usage: clip speed <input> [<factor>] [<reverse>]\n');
      process.exit(1);
    }
    const speedArgs = {
      input,
      factor: factor ? Number(factor) : undefined,
      reverse: reverse === 'true' ? true : reverse === 'false' ? false : undefined,
    };
    const result = await runAndLog('speed', speedArgs, () => speed(speedArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'overlay') {
    const [input, overlayPath, position, scaleToWidth, startSec, endSec] = args;
    if (!input || !overlayPath) {
      process.stderr.write(
        'Usage: clip overlay <base> <overlay> [<position>] [<scaleToWidth>] [<startSec>] [<endSec>]\n',
      );
      process.exit(1);
    }
    const overlayArgs = {
      input,
      overlay: overlayPath,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      position: (position as any) ?? undefined,
      scaleToWidth: scaleToWidth ? Number(scaleToWidth) : undefined,
      startSec: startSec ? Number(startSec) : undefined,
      endSec: endSec ? Number(endSec) : undefined,
    };
    const result = await runAndLog('overlay', overlayArgs, () => overlay(overlayArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'zoom_pan') {
    const [input, fromZoom, toZoom, centerX, centerY] = args;
    if (!input) {
      process.stderr.write(
        'Usage: clip zoom_pan <input> [<fromZoom>] [<toZoom>] [<centerX>] [<centerY>]\n',
      );
      process.exit(1);
    }
    const zoomPanArgs = {
      input,
      fromZoom: fromZoom ? Number(fromZoom) : undefined,
      toZoom: toZoom ? Number(toZoom) : undefined,
      centerX: centerX ? Number(centerX) : undefined,
      centerY: centerY ? Number(centerY) : undefined,
    };
    const result = await runAndLog('zoom_pan', zoomPanArgs, () => zoomPan(zoomPanArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  // ─── Composites ──────────────────────────────────────────────────────

  if (command === 'add_title_card') {
    const [input, text, durationSec, background, fontSize, fontColor] = args;
    if (!input || !text) {
      process.stderr.write(
        'Usage: clip add_title_card <input> <text> [<durationSec>] [<background>] [<fontSize>] [<fontColor>]\n',
      );
      process.exit(1);
    }
    const titleArgs = {
      input,
      text,
      durationSec: durationSec ? Number(durationSec) : undefined,
      background,
      fontSize: fontSize ? Number(fontSize) : undefined,
      fontColor,
    };
    const result = await runAndLog('add_title_card', titleArgs, () => addTitleCard(titleArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'add_captions') {
    const [input, cuesJson] = args;
    if (!input || !cuesJson) {
      process.stderr.write('Usage: clip add_captions <input> <cuesJson>\n');
      process.exit(1);
    }
    let cues: unknown;
    try {
      cues = JSON.parse(cuesJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to parse cuesJson: ${msg}\n`);
      process.exit(1);
    }
    const captionsArgs = {
      input,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates the parsed value at runtime
      cues: cues as any,
    };
    const result = await runAndLog('add_captions', captionsArgs, () => addCaptions(captionsArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'silence_remove') {
    const [input, noiseDb, minSilenceSec] = args;
    if (!input) {
      process.stderr.write('Usage: clip silence_remove <input> [<noiseDb>] [<minSilenceSec>]\n');
      process.exit(1);
    }
    const silenceArgs = {
      input,
      noiseDb: noiseDb ? Number(noiseDb) : undefined,
      minSilenceSec: minSilenceSec ? Number(minSilenceSec) : undefined,
    };
    const result = await runAndLog('silence_remove', silenceArgs, () => silenceRemove(silenceArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'highlight_reel') {
    const [input, segmentsJson, transitionKind, transitionSec] = args;
    if (!input || !segmentsJson) {
      process.stderr.write(
        'Usage: clip highlight_reel <input> <segmentsJson> [<transitionKind>] [<transitionSec>]\n',
      );
      process.exit(1);
    }
    let segments: unknown;
    try {
      segments = JSON.parse(segmentsJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to parse segmentsJson: ${msg}\n`);
      process.exit(1);
    }
    const reelArgs = {
      input,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates the parsed value at runtime
      segments: segments as any,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      transitionKind: (transitionKind as any) ?? undefined,
      transitionSec: transitionSec ? Number(transitionSec) : undefined,
    };
    const result = await runAndLog('highlight_reel', reelArgs, () => highlightReel(reelArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  // ─── Specialty ───────────────────────────────────────────────────────

  if (command === 'chroma_key') {
    const [foreground, background, color, similarity, blend] = args;
    if (!foreground || !background) {
      process.stderr.write(
        'Usage: clip chroma_key <foreground> <background> [<color>] [<similarity>] [<blend>]\n',
      );
      process.exit(1);
    }
    const chromaArgs = {
      foreground,
      background,
      color: color ?? undefined,
      similarity: similarity ? Number(similarity) : undefined,
      blend: blend ? Number(blend) : undefined,
    };
    const result = await runAndLog('chroma_key', chromaArgs, () => chromaKey(chromaArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'stabilize') {
    const [input, shakiness, smoothing, accuracy, zoom] = args;
    if (!input) {
      process.stderr.write(
        'Usage: clip stabilize <input> [<shakiness>] [<smoothing>] [<accuracy>] [<zoom>]\n',
      );
      process.exit(1);
    }
    const stabilizeArgs = {
      input,
      shakiness: shakiness ? Number(shakiness) : undefined,
      smoothing: smoothing ? Number(smoothing) : undefined,
      accuracy: accuracy ? Number(accuracy) : undefined,
      zoom: zoom ? Number(zoom) : undefined,
    };
    const result = await runAndLog('stabilize', stabilizeArgs, () => stabilize(stabilizeArgs));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  // ─── UI ──────────────────────────────────────────────────────────────

  if (command === 'ui') {
    const server = await startUiServer();
    process.stdout.write(`MakeMyClip Editor UI: ${server.url}\n`);
    process.stdout.write('Press Ctrl+C to stop.\n');
    const stopAndExit = async () => {
      process.stdout.write('\nShutting down…\n');
      await server.stop();
      process.exit(0);
    };
    process.on('SIGINT', stopAndExit);
    process.on('SIGTERM', stopAndExit);
    // Keep the process alive — serve() already binds a listener but doesn't
    // hold the event loop open on its own when called from a short-lived CLI
    // script. A no-op interval is the simplest way to stay running until
    // SIGINT/SIGTERM fires.
    setInterval(() => undefined, 1 << 30);
    return;
  }

  // ─── Session-management tools (do not log themselves) ────────────────

  if (command === 'snapshot') {
    const [label] = args;
    const result = await snapshot({ label });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'undo') {
    const [snapshotLabel] = args;
    const result = await undo({ snapshotLabel });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'inspect') {
    const [limit] = args;
    const result = await inspect({ limit: limit ? Number(limit) : undefined });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'delete') {
    const [id, removeFile] = args;
    if (!id) {
      process.stderr.write('Usage: clip delete <id> [<removeFile>]\n');
      process.exit(1);
    }
    const result = await deleteOp({ id, removeFile: removeFile === 'true' });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
