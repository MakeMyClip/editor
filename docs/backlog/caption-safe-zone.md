# Caption safe zone for vertical video

Captions sit 40 px from the bottom edge (`EDGE` in `src/timeline/compile.ts`) whatever the canvas shape. On a 9:16 export, the Shorts, Reels and TikTok overlays (caption text, buttons) cover roughly the bottom fifth of the frame, so bottom-anchored captions land under them. Raise the default caption position on portrait canvases, or add a safe-zone offset to the caption style.
