# Frame preview encodes a short window

`buildFrameAtPlan` (`src/timeline/compile.ts`) encodes the whole clip's segment to grab one frame, so every framing change in the browser UI re-encodes the full clip before the viewer updates. On a long uncut recording that takes seconds. Encode only a short window around the requested time (`-ss` before the input, `-t` of a few frames) and adjust the frame offset, keeping the same filter chain so the preview still matches export.
