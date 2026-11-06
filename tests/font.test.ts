import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fontFileFor, MissingFontError, readCoverage } from '../src/ffmpeg/font.js';

// Minimal fonts: just an sfnt header and a `cmap`, which is all the coverage
// check reads.

/** A format 12 subtable mapping each [start, end] range to glyphs from 1. */
function format12(ranges: [number, number][]): Buffer {
  const buf = Buffer.alloc(16 + ranges.length * 12);
  buf.writeUInt16BE(12, 0);
  buf.writeUInt32BE(buf.length, 4);
  buf.writeUInt32BE(ranges.length, 12);
  let glyph = 1;
  ranges.forEach(([start, end], i) => {
    buf.writeUInt32BE(start, 16 + i * 12);
    buf.writeUInt32BE(end, 20 + i * 12);
    buf.writeUInt32BE(glyph, 24 + i * 12);
    glyph += end - start + 1;
  });
  return buf;
}

/** A format 4 subtable: one delta-mapped segment, one through the glyph array
 *  (whose second entry is glyph 0, i.e. missing), and the 0xFFFF terminator. */
function format4(): Buffer {
  const segments = [
    { start: 0x41, end: 0x5a, delta: -0x40, rangeOffset: 0 }, // A–Z
    { start: 0x430, end: 0x431, delta: 0, rangeOffset: 1 }, // а (glyph 30), б (0)
    { start: 0xffff, end: 0xffff, delta: 1, rangeOffset: 0 },
  ];
  const n = segments.length;
  const glyphArray = [30, 0];
  const buf = Buffer.alloc(16 + n * 8 + glyphArray.length * 2);
  buf.writeUInt16BE(4, 0);
  buf.writeUInt16BE(buf.length, 2);
  buf.writeUInt16BE(n * 2, 6);
  const ends = 14;
  const starts = ends + n * 2 + 2;
  const deltas = starts + n * 2;
  const offsets = deltas + n * 2;
  segments.forEach((s, i) => {
    buf.writeUInt16BE(s.end, ends + i * 2);
    buf.writeUInt16BE(s.start, starts + i * 2);
    buf.writeInt16BE(s.delta, deltas + i * 2);
    // Bytes from this idRangeOffset entry to the glyph array.
    const toArray = (n - i) * 2;
    buf.writeUInt16BE(s.rangeOffset ? toArray : 0, offsets + i * 2);
  });
  for (const [i, g] of glyphArray.entries()) buf.writeUInt16BE(g, offsets + n * 2 + i * 2);
  return buf;
}

function sfnt(platform: number, encoding: number, subtable: Buffer, base = 0): Buffer {
  const cmap = Buffer.concat([Buffer.alloc(12), subtable]);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(platform, 4);
  cmap.writeUInt16BE(encoding, 6);
  cmap.writeUInt32BE(12, 8);
  const header = Buffer.alloc(28);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);
  header.write('cmap', 12, 'latin1');
  header.writeUInt32BE(base + 28, 20);
  header.writeUInt32BE(cmap.length, 24);
  return Buffer.concat([header, cmap]);
}

/** A collection whose first font is `font`; table offsets count from the file start. */
function ttc(fontAt12: (base: number) => Buffer): Buffer {
  const head = Buffer.alloc(16);
  head.write('ttcf', 0, 'latin1');
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(1, 8);
  head.writeUInt32BE(16, 12);
  return Buffer.concat([head, fontAt12(16)]);
}

let dir: string;
const paths: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mmc-font-'));
  const fonts: Record<string, Buffer> = {
    latin: sfnt(3, 1, format4()),
    cyrillic: sfnt(
      3,
      10,
      format12([
        [0x20, 0x7e],
        [0x400, 0x4ff],
      ]),
    ),
    cjk: ttc((base) =>
      sfnt(
        0,
        4,
        format12([
          [0x20, 0x7e],
          [0x400, 0x4ff],
          [0x4e00, 0x9fff],
        ]),
        base,
      ),
    ),
    symbolOnly: sfnt(3, 0, format12([[0x4e00, 0x9fff]])),
  };
  for (const [name, buf] of Object.entries(fonts)) {
    paths[name] = join(dir, `${name}.ttf`);
    await writeFile(paths[name], buf);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readCoverage', () => {
  it('reads format 4, including glyph-array segments and glyph 0 as missing', () => {
    const covers = readCoverage(paths.latin as string);
    expect(covers?.(0x41)).toBe(true);
    expect(covers?.(0x61)).toBe(false);
    expect(covers?.(0x430)).toBe(true);
    expect(covers?.(0x431)).toBe(false);
    expect(covers?.(0x1f600)).toBe(false);
  });

  it('reads format 12 and the first font of a collection', () => {
    expect(readCoverage(paths.cyrillic as string)?.(0x416)).toBe(true);
    const cjk = readCoverage(paths.cjk as string);
    expect(cjk?.(0x4f60)).toBe(true);
    expect(cjk?.(0x3042)).toBe(false);
  });

  it('ignores non-Unicode subtables', () => {
    expect(readCoverage(paths.symbolOnly as string)).toBeNull();
  });
});

describe('fontFileFor', () => {
  const candidates = () => [
    join(dir, 'missing.ttf'),
    paths.latin as string,
    paths.cyrillic as string,
    paths.cjk as string,
  ];

  it('leaves Latin text on the default font', () => {
    expect(fontFileFor('Café, “quoted” — fine', { candidates: candidates() })).toBeUndefined();
  });

  it('gives Latin text a file only when asked, and the default font when none is readable', () => {
    expect(fontFileFor('PLAIN CAPTION', { always: true, candidates: candidates() })).toBe(
      paths.latin,
    );
    expect(
      fontFileFor('PLAIN CAPTION', { always: true, candidates: [join(dir, 'missing.ttf')] }),
    ).toBeUndefined();
  });

  it('picks the first font that has every glyph, skipping unreadable ones', () => {
    expect(fontFileFor('Жизнь', { candidates: candidates() })).toBe(paths.cyrillic);
    expect(fontFileFor('Жизнь 你好', { candidates: candidates() })).toBe(paths.cjk);
  });

  it('names the characters no font has', () => {
    expect(() => fontFileFor('Жизнь あ', { candidates: candidates() })).toThrow(MissingFontError);
    try {
      fontFileFor('Жизнь あ', { candidates: candidates() });
    } catch (err) {
      expect((err as MissingFontError).missing).toBe('あ');
      expect((err as Error).message).toMatch(/MAKEMYCLIP_FALLBACK_FONT/);
    }
  });
});
