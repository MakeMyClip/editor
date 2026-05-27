#!/usr/bin/env node
import { addAudio } from './tools/add-audio.js';
import { addText } from './tools/add-text.js';
import { adjust } from './tools/adjust.js';
import { concat } from './tools/concat.js';
import { ingest } from './tools/ingest.js';
import { overlay } from './tools/overlay.js';
import { preview } from './tools/preview.js';
import { render } from './tools/render.js';
import { speed } from './tools/speed.js';
import { split } from './tools/split.js';
import { type TransformResult, transform } from './tools/transform.js';
import { transition } from './tools/transition.js';
import { trim } from './tools/trim.js';
import { zoomPan } from './tools/zoom-pan.js';

const HELP = `clip — MakeMyClip Editor

Usage:
  clip ingest <input>
      Probe a media file and return its metadata.

  clip trim <input> <start> <end>
      Trim a clip between two timecodes (stream-copy, no re-encode).

  clip split <input> <atSec>
      Split a clip at <atSec> into before/after halves (stream-copy,
      keyframe-accurate).

  clip concat <input1> <input2> [<input3> ...]
      Stitch two or more clips back-to-back (stream-copy; requires
      matching codecs across all inputs).

  clip add_text <input> <text> <position> <startSec> <endSec>
      Burn a text overlay into a copy of the video.
      Positions: top-left top-center top-right center-left center center-right
                 bottom-left bottom-center bottom-right
      Defaults: fontsize 48, white text, translucent box for readability.

  clip add_audio <input> <audio> [<mode>] [<audioVolume>] [<startSec>]
      Mix in or replace audio. Mode 'mix' (default) keeps the base
      audio; 'replace' drops it.
      Defaults: mode=mix, audioVolume=0.5, startSec=0.

  clip preview <input> <atSec>
      Extract a single frame as JPEG. Use after any edit to verify
      output before continuing.

  clip transition <inputA> <inputB> [<kind>] [<durationSec>]
      Crossfade or slide between two clips. Auto-probes clip A so
      you don't need to know its duration.
      Kinds: fade fadeblack fadewhite dissolve
             wipeleft wiperight wipeup wipedown
             slideleft slideright circleopen circleclose
      Defaults: kind=fade, durationSec=1.

  clip render <input> [<format>] [<crf>] [<preset>] [<maxWidth>]
      Re-encode with specific codec / quality / resize.
      Formats: mp4 (default, h264+aac), mov (h264+aac), webm (vp9+opus)
      CRF: 0 (lossless) to 51 (worst); default 23.
      Preset: ultrafast..veryslow (libx264 only); default medium.
      Defaults: format=mp4, crf=23, preset=medium, no resize.

  clip transform <op> <input> [<op-args>...]
      Geometric transform. <op> is one of:
        crop <x> <y> <width> <height>
        rotate <90|180|270>
        flip <horizontal|vertical>
        scale [<width>] [<height>]    (-1 for either = auto-fit even-pixel)

  clip adjust <input> [--brightness N] [--contrast N] [--saturation N] [--volume N]
      Color/audio adjustment. At least one knob must be set.
      Ranges: brightness -1..1 (0=none), contrast 0..4 (1=none),
              saturation 0..3 (1=none), volume 0..2 (1=none).

  clip speed <input> [<factor>] [<reverse>]
      Slow-mo / fast-forward / reverse. factor=2 means double speed;
      0.5 means half (slow-mo). reverse is 'true' or 'false'.

  clip overlay <base> <overlay> [<position>] [<scaleToWidth>] [<startSec>] [<endSec>]
      PiP / image overlay. position defaults to top-right.
      Positions: top-left top-center top-right center-left center center-right
                 bottom-left bottom-center bottom-right

  clip zoom_pan <input> [<fromZoom>] [<toZoom>] [<centerX>] [<centerY>]
      Ken Burns / focus zoom over the full clip duration.
      Defaults: fromZoom=1, toZoom=1.5, center=(0.5, 0.5).

  clip --help
      Show this help.

Examples:
  clip ingest screen.mp4
  clip trim screen.mp4 00:00:05 00:00:42
  clip concat intro.mp4 demo.mp4 outro.mp4
  clip add_text screen.mp4 "New dashboard" bottom-center 5 9
  clip preview screen.mp4 12.5
  clip transition intro.mp4 demo.mp4 fade 1
`;

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
    const result = await ingest({ path: input });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'trim') {
    const [input, start, end] = args;
    if (!input || !start || !end) {
      process.stderr.write('Usage: clip trim <input> <start> <end>\n');
      process.exit(1);
    }
    const result = await trim({ input, start, end });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'split') {
    const [input, atSec] = args;
    if (!input || atSec === undefined) {
      process.stderr.write('Usage: clip split <input> <atSec>\n');
      process.exit(1);
    }
    const result = await split({ input, atSec: Number(atSec) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'concat') {
    if (args.length < 2) {
      process.stderr.write('Usage: clip concat <input1> <input2> [<input3> ...]\n');
      process.exit(1);
    }
    const result = await concat({ inputs: args });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'preview') {
    const [input, atSec] = args;
    if (!input || atSec === undefined) {
      process.stderr.write('Usage: clip preview <input> <atSec>\n');
      process.exit(1);
    }
    const result = await preview({ input, atSec: Number(atSec) });
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
    const result = await render({
      input,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      format: (format as any) ?? undefined,
      crf: crf ? Number(crf) : undefined,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      preset: (preset as any) ?? undefined,
      maxWidth: maxWidth ? Number(maxWidth) : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'transition') {
    const [inputA, inputB, kind, durationSec] = args;
    if (!inputA || !inputB) {
      process.stderr.write('Usage: clip transition <inputA> <inputB> [<kind>] [<durationSec>]\n');
      process.exit(1);
    }
    const result = await transition({
      inputA,
      inputB,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates the value at runtime
      kind: (kind as any) ?? undefined,
      durationSec: durationSec ? Number(durationSec) : undefined,
    });
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
    const result = await addAudio({
      input,
      audio,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      mode: (mode as any) ?? undefined,
      audioVolume: audioVolume ? Number(audioVolume) : undefined,
      startSec: startSec ? Number(startSec) : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'add_text') {
    const [input, text, position, startSec, endSec] = args;
    if (!input || !text || !position || !startSec || !endSec) {
      process.stderr.write(
        'Usage: clip add_text <input> <text> <position> <startSec> <endSec>\n' +
          'Positions: top-left top-center top-right center-left center center-right bottom-left bottom-center bottom-right\n',
      );
      process.exit(1);
    }
    const result = await addText({
      input,
      text,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates the value at runtime
      position: position as any,
      startSec: Number(startSec),
      endSec: Number(endSec),
    });
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
    if (op === 'crop') {
      const [x, y, width, height] = rest;
      if (!x || !y || !width || !height) {
        process.stderr.write('Usage: clip transform crop <input> <x> <y> <width> <height>\n');
        process.exit(1);
      }
      result = await transform({
        op: 'crop',
        input,
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      });
    } else if (op === 'rotate') {
      const [degrees] = rest;
      if (!degrees) {
        process.stderr.write('Usage: clip transform rotate <input> <90|180|270>\n');
        process.exit(1);
      }
      const d = Number(degrees);
      if (d !== 90 && d !== 180 && d !== 270) {
        process.stderr.write('rotate degrees must be 90, 180, or 270\n');
        process.exit(1);
      }
      result = await transform({ op: 'rotate', input, degrees: d });
    } else if (op === 'flip') {
      const [axis] = rest;
      if (axis !== 'horizontal' && axis !== 'vertical') {
        process.stderr.write('Usage: clip transform flip <input> <horizontal|vertical>\n');
        process.exit(1);
      }
      result = await transform({ op: 'flip', input, axis });
    } else if (op === 'scale') {
      const [width, height] = rest;
      result = await transform({
        op: 'scale',
        input,
        width: width ? Number(width) : undefined,
        height: height ? Number(height) : undefined,
      });
    } else {
      process.stderr.write(`Unknown transform op: ${op} (expected crop|rotate|flip|scale)\n`);
      process.exit(1);
    }
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
    const result = await adjust({
      input,
      brightness: flags.brightness,
      contrast: flags.contrast,
      saturation: flags.saturation,
      volume: flags.volume,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'speed') {
    const [input, factor, reverse] = args;
    if (!input) {
      process.stderr.write('Usage: clip speed <input> [<factor>] [<reverse>]\n');
      process.exit(1);
    }
    const result = await speed({
      input,
      factor: factor ? Number(factor) : undefined,
      reverse: reverse === 'true' ? true : reverse === 'false' ? false : undefined,
    });
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
    const result = await overlay({
      input,
      overlay: overlayPath,
      // biome-ignore lint/suspicious/noExplicitAny: Zod validates at runtime
      position: (position as any) ?? undefined,
      scaleToWidth: scaleToWidth ? Number(scaleToWidth) : undefined,
      startSec: startSec ? Number(startSec) : undefined,
      endSec: endSec ? Number(endSec) : undefined,
    });
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
    const result = await zoomPan({
      input,
      fromZoom: fromZoom ? Number(fromZoom) : undefined,
      toZoom: toZoom ? Number(toZoom) : undefined,
      centerX: centerX ? Number(centerX) : undefined,
      centerY: centerY ? Number(centerY) : undefined,
    });
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
