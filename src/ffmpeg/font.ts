import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pick a font file for text FFmpeg's default font may not cover. drawtext
 * draws every character from one font and has no per-glyph fallback, so text
 * outside Latin (Cyrillic, CJK, …) needs a font that has all of its glyphs;
 * the wrong one draws empty boxes. Fonts come from the system or from
 * `MAKEMYCLIP_FALLBACK_FONT`; nothing is downloaded. Each candidate's
 * character map is read once per process and checked against the text.
 *
 * Captions ask for a file even for Latin text: each drawtext without one asks
 * fontconfig for the default font, about a quarter second per caption with a
 * Homebrew FFmpeg, while a file loads in milliseconds.
 */

/** Thrown when no available font has every glyph the text needs. */
export class MissingFontError extends Error {
  readonly missing: string;
  constructor(missing: string) {
    super(
      `No font on this system has glyphs for "${missing}". Install one that does ` +
        '(for Chinese, Japanese or Korean, Noto Sans CJK: `sudo apt install fonts-noto-cjk` on ' +
        'Debian or Ubuntu), or set MAKEMYCLIP_FALLBACK_FONT to a .ttf, .otf or .ttc file that has them.',
    );
    this.name = 'MissingFontError';
    this.missing = missing;
  }
}

/** Latin, Latin-1 and general punctuation: what text rendered without a font
 *  file has always used, so that text keeps FFmpeg's default font. */
function usesDefaultFont(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xff && (cp < 0x2000 || cp > 0x206f)) return false;
  }
  return true;
}

/** Broad-coverage fonts first, so mixed text lands in one font. */
function systemFonts(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        '/Library/Fonts/Arial Unicode.ttf',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
        '/System/Library/Fonts/AppleSDGothicNeo.ttc',
        '/System/Library/Fonts/Supplemental/Songti.ttc',
      ];
    case 'win32': {
      const dir = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
      return [
        'arial.ttf',
        'segoeui.ttf',
        'msyh.ttc',
        'YuGothM.ttc',
        'malgun.ttf',
        'simsun.ttc',
      ].map((f) => join(dir, f));
    }
    default:
      return [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
        '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
        '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
      ];
  }
}

/** The fonts tried in order: `MAKEMYCLIP_FALLBACK_FONT`, then the system's. */
export function fallbackFontCandidates(): string[] {
  const explicit = process.env.MAKEMYCLIP_FALLBACK_FONT;
  return explicit ? [explicit, ...systemFonts()] : systemFonts();
}

export interface FontOptions {
  /** Return a file for Latin text too (when one is installed), not just
   *  for the text FFmpeg's default font may lack. */
  always?: boolean;
  candidates?: string[];
}

/**
 * The font file to draw `text` with: the first candidate whose character map
 * covers every character. Latin text gets undefined (FFmpeg's default font)
 * unless `always` is set, and falls back to it when no candidate is readable.
 * Throws `MissingFontError` when no font has the glyphs of other text.
 */
export function fontFileFor(text: string, opts: FontOptions = {}): string | undefined {
  const latin = usesDefaultFont(text);
  if (latin && !opts.always) return undefined;
  const candidates = opts.candidates ?? fallbackFontCandidates();
  const needed = [...new Set(text)]
    .map((ch) => ch.codePointAt(0) ?? 0)
    .filter((cp) => cp > 0x20 && !isInvisible(cp));
  for (const path of candidates) {
    const covers = coverageOf(path);
    if (covers && needed.every(covers)) return path;
  }
  if (latin) return undefined;
  const missing = needed.filter((cp) => !candidates.some((p) => coverageOf(p)?.(cp)));
  throw new MissingFontError(String.fromCodePoint(...missing.slice(0, 12)));
}

/** Spaces and format characters draw nothing, so no font needs them. */
function isInvisible(cp: number): boolean {
  return /[\p{White_Space}\p{Cf}]/u.test(String.fromCodePoint(cp));
}

type Coverage = (codePoint: number) => boolean;

const coverageCache = new Map<string, Coverage | null>();

/** The font's character map as a lookup, or null when it can't be read. */
function coverageOf(path: string): Coverage | null {
  let covers = coverageCache.get(path);
  if (covers === undefined) {
    try {
      covers = readCoverage(path);
    } catch {
      covers = null;
    }
    coverageCache.set(path, covers);
  }
  return covers;
}

/**
 * Read the `cmap` of a TrueType/OpenType font, or of the first font in a
 * collection (.ttc): drawtext opens face 0. Uses the full-Unicode subtable
 * (format 12) when there is one, else the BMP one (format 4).
 */
export function readCoverage(path: string): Coverage | null {
  const fd = openSync(path, 'r');
  try {
    const read = (offset: number, length: number): Buffer => {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, offset);
      if (n < length) throw new Error(`Truncated font file: ${path}`);
      return buf;
    };
    let fontOffset = 0;
    const head = read(0, 12);
    if (head.toString('latin1', 0, 4) === 'ttcf') fontOffset = read(12, 4).readUInt32BE(0);
    const numTables = read(fontOffset + 4, 2).readUInt16BE(0);
    const dir = read(fontOffset + 12, numTables * 16);
    let cmap: Buffer | null = null;
    for (let i = 0; i < numTables; i++) {
      if (dir.toString('latin1', i * 16, i * 16 + 4) === 'cmap') {
        cmap = read(dir.readUInt32BE(i * 16 + 8), dir.readUInt32BE(i * 16 + 12));
        break;
      }
    }
    return cmap ? parseCmap(cmap) : null;
  } finally {
    closeSync(fd);
  }
}

/** A Unicode subtable of a `cmap` table as a lookup (formats 12 and 4). */
export function parseCmap(cmap: Buffer): Coverage | null {
  const count = cmap.readUInt16BE(2);
  let format4: number | null = null;
  for (let i = 0; i < count; i++) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    const offset = cmap.readUInt32BE(8 + i * 8);
    const isUnicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!isUnicode) continue;
    const format = cmap.readUInt16BE(offset);
    if (format === 12) return format12(cmap, offset);
    if (format === 4 && format4 === null) format4 = offset;
  }
  return format4 === null ? null : format4Lookup(cmap, format4);
}

function format12(cmap: Buffer, offset: number): Coverage {
  const groups = cmap.readUInt32BE(offset + 12);
  const ranges: [number, number, number][] = [];
  for (let g = 0; g < groups; g++) {
    const at = offset + 16 + g * 12;
    ranges.push([cmap.readUInt32BE(at), cmap.readUInt32BE(at + 4), cmap.readUInt32BE(at + 8)]);
  }
  return (cp) =>
    ranges.some(([start, end, glyph]) => cp >= start && cp <= end && glyph + (cp - start) !== 0);
}

function format4Lookup(cmap: Buffer, offset: number): Coverage {
  const segments = cmap.readUInt16BE(offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  return (cp) => {
    if (cp > 0xffff) return false;
    for (let s = 0; s < segments; s++) {
      if (cp > cmap.readUInt16BE(ends + s * 2)) continue;
      const start = cmap.readUInt16BE(starts + s * 2);
      if (cp < start) return false;
      const delta = cmap.readInt16BE(deltas + s * 2);
      const rangeOffset = cmap.readUInt16BE(rangeOffsets + s * 2);
      if (rangeOffset === 0) return ((cp + delta) & 0xffff) !== 0;
      const at = rangeOffsets + s * 2 + rangeOffset + (cp - start) * 2;
      if (at + 2 > cmap.length) return false;
      const glyph = cmap.readUInt16BE(at);
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
    return false;
  };
}
