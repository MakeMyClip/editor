# Caption width follows the font size

`groupCaptions` breaks captions at 32 Latin characters (`MAX_CAPTION_WIDTH` in `src/timeline/captions.ts`) whatever the font size, and drawtext doesn't wrap. With the default size (the canvas short side / 20) a caption fits, but a larger `--font` makes long captions run off both edges. Derive the limit from the effective font size and the canvas width.
