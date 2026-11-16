# Caption width from the font's own metrics

Caption lines are fitted by `textWidthEm` in `src/timeline/captions.ts`, an estimate per character class that errs wide for Arial and DejaVu Sans (W and m at 1 em, other capitals 0.8, non-Latin letters 0.95–1.1). A font wider than those, or a glyph outside the classes, can still overflow the safe area. Read the advance widths from the font file the caption is drawn with (`fontFileFor` in `src/ffmpeg/font.ts` already parses its character map) and fit lines by them.
