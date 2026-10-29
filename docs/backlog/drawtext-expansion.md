# drawtext expansion

No drawtext call sets `expansion=none`, so FFmpeg expands `%` sequences in user text: "50% off" fails with "Stray %" and backslashes get eaten. Set `expansion=none` in src/ffmpeg/args/add-text.ts and the drawtext builder in src/timeline/compile.ts.
