# drawtext expansion

`src/ffmpeg/args/add-text.ts` doesn't set `expansion=none`, so FFmpeg expands `%` sequences in user text: "50% off" fails with "Stray %" and backslashes get eaten. Set it there too (timeline text and captions already do).
