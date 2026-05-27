#!/usr/bin/env node
import { addText } from './tools/add-text.js';
import { concat } from './tools/concat.js';
import { ingest } from './tools/ingest.js';
import { preview } from './tools/preview.js';
import { trim } from './tools/trim.js';

const HELP = `clip — MakeMyClip Editor

Usage:
  clip ingest <input>
      Probe a media file and return its metadata.

  clip trim <input> <start> <end>
      Trim a clip between two timecodes (stream-copy, no re-encode).

  clip concat <input1> <input2> [<input3> ...]
      Stitch two or more clips back-to-back (stream-copy; requires
      matching codecs across all inputs).

  clip add_text <input> <text> <position> <startSec> <endSec>
      Burn a text overlay into a copy of the video.
      Positions: top-left top-center top-right center-left center center-right
                 bottom-left bottom-center bottom-right
      Defaults: fontsize 48, white text, translucent box for readability.

  clip preview <input> <atSec>
      Extract a single frame as JPEG. Use after any edit to verify
      output before continuing.

  clip --help
      Show this help.

Examples:
  clip ingest screen.mp4
  clip trim screen.mp4 00:00:05 00:00:42
  clip concat intro.mp4 demo.mp4 outro.mp4
  clip add_text screen.mp4 "New dashboard" bottom-center 5 9
  clip preview screen.mp4 12.5
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

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
