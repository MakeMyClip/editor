import { quoteFilterArg } from '../escape.js';

export type NamedPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface AddTextArgs {
  input: string;
  output: string;
  /** Path to a UTF-8 text file containing the overlay text. */
  textfile: string;
  position: NamedPosition;
  startSec: number;
  endSec: number;
  fontSize?: number;
  /** Color as a CSS name, '#RRGGBB', or '0xRRGGBB[@alpha]'. */
  color?: string;
  /** Translucent background box for readability. */
  box?: boolean;
}

// Padding from the edge of the frame. Matches what users intuitively expect
// from a "bottom-center" placement — neither flush nor floating awkwardly.
const EDGE_PADDING = 20;

const POSITION_EXPR: Record<NamedPosition, { x: string; y: string }> = {
  'top-left': { x: `${EDGE_PADDING}`, y: `${EDGE_PADDING}` },
  'top-center': { x: '(w-text_w)/2', y: `${EDGE_PADDING}` },
  'top-right': { x: `w-text_w-${EDGE_PADDING}`, y: `${EDGE_PADDING}` },
  'center-left': { x: `${EDGE_PADDING}`, y: '(h-text_h)/2' },
  center: { x: '(w-text_w)/2', y: '(h-text_h)/2' },
  'center-right': { x: `w-text_w-${EDGE_PADDING}`, y: '(h-text_h)/2' },
  'bottom-left': { x: `${EDGE_PADDING}`, y: `h-text_h-${EDGE_PADDING}` },
  'bottom-center': { x: '(w-text_w)/2', y: `h-text_h-${EDGE_PADDING}` },
  'bottom-right': { x: `w-text_w-${EDGE_PADDING}`, y: `h-text_h-${EDGE_PADDING}` },
};

export function buildAddTextArgs(args: AddTextArgs): string[] {
  const fontSize = args.fontSize ?? 48;
  const color = args.color ?? 'white';
  const box = args.box ?? true;
  const { x, y } = POSITION_EXPR[args.position];

  const drawtextOpts: string[] = [
    `textfile=${quoteFilterArg(args.textfile)}`,
    `fontsize=${fontSize}`,
    `fontcolor=${quoteFilterArg(color)}`,
    `x=${quoteFilterArg(x)}`,
    `y=${quoteFilterArg(y)}`,
    `enable=${quoteFilterArg(`between(t,${args.startSec},${args.endSec})`)}`,
  ];

  if (box) {
    drawtextOpts.push('box=1', `boxcolor=${quoteFilterArg('black@0.5')}`, 'boxborderw=8');
  }

  const filter = `drawtext=${drawtextOpts.join(':')}`;

  // drawtext requires re-encoding the video stream. Audio stream-copies
  // through unchanged. -c:a copy is a no-op on inputs without audio.
  return [
    '-y',
    '-i',
    args.input,
    '-vf',
    filter,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    args.output,
  ];
}
