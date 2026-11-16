import { z } from 'zod';

/**
 * Timeline colors reach FFmpeg as bare option values (`color=c=…`,
 * `pad=…:color=…`), where a comma, semicolon or bracket starts a new filter. So a
 * color must be one FFmpeg reads as a color and nothing more: anything else
 * could add filters such as `movie=`, which reads any file on disk.
 */

/** FFmpeg's color names (`ffmpeg -colors`), which it matches in any case. */
const COLOR_NAMES = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
  crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkkhaki darkmagenta
  darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue
  darkslategray darkturquoise darkviolet deeppink deepskyblue dimgray dodgerblue firebrick
  floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow
  honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
  lightblue lightcoral lightcyan lightgoldenrodyellow lightgreen lightgrey lightpink
  lightsalmon lightseagreen lightskyblue lightslategray lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple
  mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred
  midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange
  orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff
  peru pink plum powderblue purple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray snow springgreen steelblue tan
  teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/),
);

const HEX = /^(?:#|0x)?[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const HEX_ALPHA = /^0x[0-9a-fA-F]{1,2}$/;
const DECIMAL_ALPHA = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Whether `value` is a color FFmpeg reads: a color name or hex (`#rrggbb`,
 *  `0xrrggbbaa`), with an optional `@alpha` from 0 to 1 (or 0x00 to 0xff). */
export function isColor(value: string): boolean {
  const [base = '', alpha, ...rest] = value.split('@');
  if (rest.length > 0) return false;
  if (!HEX.test(base) && !COLOR_NAMES.has(base.toLowerCase())) return false;
  return (
    alpha === undefined ||
    HEX_ALPHA.test(alpha) ||
    (DECIMAL_ALPHA.test(alpha) && Number(alpha) <= 1)
  );
}

/** Why `value` was refused, with the forms that work. */
export function invalidColorMessage(value: string): string {
  return (
    `${JSON.stringify(value)} is not a color. Use a color name like black or white, ` +
    'or hex like #ffcc00, optionally with @0.5 for opacity.'
  );
}

/** A color from an MCP client, the UI or the CLI (see `isColor`). */
export const ColorSchema = z
  .string()
  .refine(isColor, { error: (issue) => invalidColorMessage(String(issue.input)) });
