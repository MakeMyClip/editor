import { quoteFilterArg } from '../escape.js';

export type OverlayPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface OverlayArgs {
  input: string;
  overlay: string;
  output: string;
  position: OverlayPosition;
  /** Optional overlay-width cap in pixels; height auto-fits even-pixel. */
  scaleToWidth?: number;
  /** When the overlay appears (seconds). Default 0. */
  startSec: number;
  /** When the overlay disappears (seconds). Undefined = until end of base video. */
  endSec?: number;
  hasBaseAudio: boolean;
}

const EDGE_PAD = 20;

// Overlay filter coordinates. W/H = base dimensions, w/h = overlay dimensions.
// These are ffmpeg-recognized aliases in the overlay filter expression context.
const POSITION_EXPR: Record<OverlayPosition, { x: string; y: string }> = {
  'top-left': { x: `${EDGE_PAD}`, y: `${EDGE_PAD}` },
  'top-center': { x: '(W-w)/2', y: `${EDGE_PAD}` },
  'top-right': { x: `W-w-${EDGE_PAD}`, y: `${EDGE_PAD}` },
  'center-left': { x: `${EDGE_PAD}`, y: '(H-h)/2' },
  center: { x: '(W-w)/2', y: '(H-h)/2' },
  'center-right': { x: `W-w-${EDGE_PAD}`, y: '(H-h)/2' },
  'bottom-left': { x: `${EDGE_PAD}`, y: `H-h-${EDGE_PAD}` },
  'bottom-center': { x: '(W-w)/2', y: `H-h-${EDGE_PAD}` },
  'bottom-right': { x: `W-w-${EDGE_PAD}`, y: `H-h-${EDGE_PAD}` },
};

export function buildOverlayArgs(args: OverlayArgs): string[] {
  const { input, overlay, output, position, scaleToWidth, startSec, endSec, hasBaseAudio } = args;
  const { x, y } = POSITION_EXPR[position];

  // Optional pre-scale of the overlay. `-2` keeps even-pixel height.
  const scaleStage = scaleToWidth ? `[1:v]scale=${scaleToWidth}:-2[ov]` : '[1:v]null[ov]';

  const overlayOpts: string[] = [`x=${x}`, `y=${y}`];
  if (endSec !== undefined) {
    overlayOpts.push(`enable=${quoteFilterArg(`between(t,${startSec},${endSec})`)}`);
  } else if (startSec > 0) {
    overlayOpts.push(`enable=${quoteFilterArg(`gte(t,${startSec})`)}`);
  }

  const overlayStage = `[0:v][ov]overlay=${overlayOpts.join(':')}[v]`;
  const filterComplex = `${scaleStage};${overlayStage}`;

  const audioMappings = hasBaseAudio ? ['-map', '0:a', '-c:a', 'copy'] : [];

  return [
    '-y',
    '-i',
    input,
    '-i',
    overlay,
    '-filter_complex',
    filterComplex,
    '-map',
    '[v]',
    ...audioMappings,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    output,
  ];
}
