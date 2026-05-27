---
name: MakeMyClip/editor
description: AI-native video editor for any agent. Trim, zoom, caption, concat, and render via structured timeline JSON.
version: 0.0.1
license: MIT
homepage: https://github.com/MakeMyClip/editor
runtime: node
install: npx skills add MakeMyClip/editor
---

# MakeMyClip Editor — Agent Skill

Drive a local video editor by chatting. When triggered, this skill shells out to the `clip` CLI via `npx` (auto-downloaded on first use, cached after). No MCP setup, no global install, no config edits.

## When to invoke

Trigger this skill when the user asks to:

- Edit, trim, cut, or splice a video file
- Zoom, pan, or apply Ken Burns to a region of a clip
- Add captions, titles, or lower-thirds to footage
- Assemble multiple clips into one (concat, montage)
- Render a screen recording into a demo or social clip

Do **not** invoke for: pure transcription (use a speech-to-text skill), thumbnail-only image work, or live streaming.

## How to use

### Probe a media file (implemented)

```bash
npx -y @makemyclip/editor ingest <input>
```

Returns metadata as JSON — duration, video stream (codec, dimensions, fps), audio stream (codec, sample rate, channels), plus a deterministic `mediaId` derived from the absolute path:

```json
{
  "mediaId": "m_a1b2c3d4e5f6",
  "ref": {
    "path": "/abs/path/screen.mp4",
    "durationSec": 83.5,
    "video": { "codec": "h264", "width": 1920, "height": 1080, "fps": 30 },
    "audio": { "codec": "aac", "sampleRate": 48000, "channels": "stereo" }
  }
}
```

Call this first to ground yourself in what the source actually contains — duration for trim calculations, dimensions for zoom/overlay placement, presence of audio before suggesting `add_audio`. Same input path always returns the same `mediaId`.

### Split a clip at a point (implemented)

```bash
npx -y @makemyclip/editor split <input> <atSec>
```

Divides a clip into two halves at `atSec`. Stream-copy (no re-encode), so it's fast — both halves are produced in parallel. Returns paths to both:

```json
{ "before": "/var/folders/.../split-before-abc.mp4", "after": "/var/folders/.../split-after-xyz.mp4", "atSec": 12.5, "durationMs": 38 }
```

Keyframe-accurate (not frame-exact) because stream-copy can't decode-and-cut mid-GOP. If you need a frame-exact split, run `render` first to re-encode, then `split`.

### Trim a clip (implemented)

```bash
npx -y @makemyclip/editor trim <input> <start> <end>
```

Timecodes accept `HH:MM:SS[.ms]`, `MM:SS`, or seconds as a number. The output is JSON:

```json
{ "path": "/var/folders/.../makemyclip-editor/trim-abc123.mp4", "durationMs": 14 }
```

Trim is stream-copy (no re-encode), so it's fast and lossless. Output lands in `$MAKEMYCLIP_WORKSPACE` (defaults to `os.tmpdir()/makemyclip-editor`).

### Add a text overlay (implemented)

```bash
npx -y @makemyclip/editor add_text <input> <text> <position> <startSec> <endSec>
```

Burns a text overlay into a copy of the video.

- `<position>` is one of: `top-left`, `top-center`, `top-right`, `center-left`, `center`, `center-right`, `bottom-left`, `bottom-center`, `bottom-right`
- `<startSec>` / `<endSec>` are seconds from the start of the input
- Defaults: font size 48, white text, translucent black background box for readability

Returns JSON:

```json
{ "path": "/var/folders/.../makemyclip-editor/add-text-abc123.mp4", "durationMs": 412 }
```

The text is written to a temp file before being passed to ffmpeg, so quotes, colons, commas, brackets, and most Unicode work without manual escaping. Caveat: literal `%{...}` in the text would be interpreted as a drawtext expression (rare in real captions; avoid).

### Stitch clips together (implemented)

```bash
npx -y @makemyclip/editor concat <input1> <input2> [<input3> ...]
```

Concatenates two or more clips back-to-back into a single output, stream-copy (no re-encode), so it's fast and lossless.

Returns JSON:

```json
{ "path": "/var/folders/.../makemyclip-editor/concat-abc123.mp4", "durationMs": 95, "inputCount": 3 }
```

All inputs must have matching codecs and resolution; if they don't, ffmpeg will fail with a clear error and the agent should re-encode (e.g. via `add_text` with a no-op text, or a future `render` call) before concatenating. The combined `trim → concat` flow is the bread-and-butter highlight-reel workflow: trim N segments, then concat them in order.

### Extract a preview frame (implemented)

```bash
npx -y @makemyclip/editor preview <input> <atSec>
```

Extracts a single JPEG frame at the given timecode. Use this **after every mutating edit** to verify the output before moving on — text overlays land where you intended, trim cuts at the right point, concat seams line up. Returns JSON:

```json
{ "path": "/var/folders/.../makemyclip-editor/preview-abc123.jpg", "atSec": 1.5, "durationMs": 12 }
```

Fast (~10-50 ms) because it uses ffmpeg's input-seek (`-ss` before `-i`) — keyframe-accurate, not frame-exact, which is fine for thumbnails. The user can open the JPEG to confirm; agents that support image inputs can read it back to self-correct.

### Transition between two clips (implemented)

```bash
npx -y @makemyclip/editor transition <inputA> <inputB> [<kind>] [<durationSec>]
```

Crossfades, slides, or fades-through-black/white between two clips. The tool auto-probes clip A to compute the right offset, so the agent never has to know clip durations.

- `<kind>` is one of: `fade`, `fadeblack`, `fadewhite`, `dissolve`, `wipeleft`, `wiperight`, `wipeup`, `wipedown`, `slideleft`, `slideright`, `circleopen`, `circleclose`. Defaults to `fade` (safest, most invisible).
- `<durationSec>` defaults to `1`. Capped at 10.

Returns JSON:

```json
{ "path": "/var/folders/.../makemyclip-editor/transition-abc.mp4", "durationMs": 320, "offsetSec": 4, "hasAudio": true }
```

Audio: if both inputs have audio, the tool wires an `acrossfade` of the same duration. If neither has audio, the output is silent. If exactly one has audio, the tool fails with a clear message — re-encode the silent one with a silent audio track first.

Combined with `concat` and `add_text`, this is the polish layer that makes multi-clip outputs feel intentional rather than abrupt.

### Re-encode for export or normalization (implemented)

```bash
npx -y @makemyclip/editor render <input> [<format>] [<crf>] [<preset>] [<maxWidth>]
```

Re-encodes a video to a specific format/quality. Useful for final export, normalizing inputs before `concat`/`transition` when codecs don't match, or downsizing for web delivery.

- `<format>` is one of: `mp4` (default, h264+aac), `mov` (h264+aac), `webm` (vp9+opus)
- `<crf>` is the quality knob (0 = lossless, 51 = worst). Default `23` is a good baseline; lower for higher quality
- `<preset>` controls libx264 speed/efficiency tradeoff: `ultrafast` … `veryslow`. Default `medium`. Ignored for webm
- `<maxWidth>` (optional) caps width in pixels. Preserves aspect ratio; never upscales

Returns JSON:

```json
{ "path": "/var/folders/.../makemyclip-editor/render-abc.mp4", "format": "mp4", "durationMs": 412 }
```

### Add audio — mix or replace (implemented)

```bash
npx -y @makemyclip/editor add_audio <input> <audio> [<mode>] [<audioVolume>] [<startSec>]
```

Add a background-music bed, a voiceover, or replace the original audio entirely.

- `<mode>` is `mix` (default — keeps base audio, overlays new audio) or `replace` (drops base audio, uses new audio only)
- `<audioVolume>` is the overlay volume multiplier (0–2, default `0.5` — sensible background-music level; use `1.0` for voiceover)
- `<startSec>` is when the overlay starts (default `0`)

Returns JSON:

```json
{ "path": "/var/folders/.../makemyclip-editor/add-audio-abc.mp4", "mode": "mix", "durationMs": 412 }
```

Mix mode requires the input video to have an audio track (use `ingest` to confirm first). Output duration matches the original video — overlay audio is truncated if longer, padded with silence if shorter.

### Crop / rotate / flip / scale (implemented)

```bash
npx -y @makemyclip/editor transform crop   <input> <x> <y> <width> <height>
npx -y @makemyclip/editor transform rotate <input> <90|180|270>
npx -y @makemyclip/editor transform flip   <input> <horizontal|vertical>
npx -y @makemyclip/editor transform scale  <input> [<width>] [<height>]
```

Geometric operations on a single video. `transform scale` uses `-2` for an omitted dimension (auto-fit preserving aspect, even-pixel for H.264). Rotation is 90° increments only — for arbitrary angles, use `render` with a custom filter graph.

### Adjust color / brightness / contrast / saturation / volume (implemented)

```bash
npx -y @makemyclip/editor adjust <input> --brightness N --contrast N --saturation N --volume N
```

One unified panel. Any subset of knobs can be set; at least one is required.

| Knob | Range | No-op value |
|---|---|---|
| `--brightness` | -1 (black) … 1 (white) | 0 |
| `--contrast` | 0 … 4 | 1 |
| `--saturation` | 0 (grayscale) … 3 (vivid) | 1 |
| `--volume` | 0 (mute) … 2 (double) | 1 |

Stream-copies whichever stream isn't being adjusted (e.g. only `--volume` set → video stream-copies, fast).

### Speed up / slow down / reverse (implemented)

```bash
npx -y @makemyclip/editor speed <input> [<factor>] [<reverse>]
```

Multiplier semantics: `factor=2` is double speed, `factor=0.5` is half (slow-mo). `reverse=true` plays backwards (audio reversed too). Either `factor != 1` or `reverse=true` is required (no-ops are rejected).

Audio handling uses `atempo` which is range-limited to [0.5, 2.0]; wider factors chain multiple `atempo` links internally so `factor=4` and `factor=0.125` both work.

### Picture-in-picture / image overlay (implemented)

```bash
npx -y @makemyclip/editor overlay <base> <overlay> [<position>] [<scaleToWidth>] [<startSec>] [<endSec>]
```

Place a video or image on top of the base. Same 9 named positions as `add_text`. Optional `scaleToWidth` to resize the overlay first (height auto-fits even-pixel). Optional time window via `startSec` + `endSec` (or just `startSec` for "from this moment to the end").

### Ken Burns / focus zoom (implemented)

```bash
npx -y @makemyclip/editor zoom_pan <input> [<fromZoom>] [<toZoom>] [<centerX>] [<centerY>]
```

Smoothly zoom from `fromZoom` to `toZoom` over the full clip duration, centered on `(centerX, centerY)` in normalized `[0, 1]` coordinates. Defaults: `fromZoom=1`, `toZoom=1.5`, center is `(0.5, 0.5)`. Use `fromZoom > toZoom` for zoom-out. Tool probes the input to match output resolution and fps.

### Add a title card (implemented)

```bash
npx -y @makemyclip/editor add_title_card <input> <text> [<durationSec>] [<background>] [<fontSize>] [<fontColor>]
```

Generates a full-screen colored card (default 2 s, black background, white text) with centered title, then concatenates it before the input. Auto-probes the input to match dimensions, fps, and audio sample rate so the join is seamless.

### Add multiple captions in one call (implemented)

```bash
npx -y @makemyclip/editor add_captions <input> <cuesJson>
```

`cuesJson` is a JSON array of `{ text, startSec, endSec, position? }`. Loops `add_text` per cue. **Does not transcribe** — the agent (or user) supplies the cues. Composability beats coupling: pair this with a separate transcription step when needed.

### Remove silence (implemented)

```bash
npx -y @makemyclip/editor silence_remove <input> [<noiseDb>] [<minSilenceSec>]
```

Detects silent regions via ffmpeg's `silencedetect` filter, then trims the non-silent regions and concatenates them. Defaults: `noiseDb=-30`, `minSilenceSec=0.5`. Pure-FFmpeg, no Python `auto-editor` dependency.

### Build a highlight reel (implemented)

```bash
npx -y @makemyclip/editor highlight_reel <input> <segmentsJson> [<transitionKind>] [<transitionSec>]
```

`segmentsJson` is a JSON array of `{ startSec, endSec }`. Trims each segment in parallel (stream-copy, fast), then either concatenates with hard cuts (no `transitionKind`) or chains the transitions tool pairwise to crossfade between them. The classic "best moments of a long video" workflow as a single agent-callable tool.

### Green-screen / color keying (implemented)

```bash
npx -y @makemyclip/editor chroma_key <foreground> <background> [<color>] [<similarity>] [<blend>]
```

Removes a color from the foreground video and composites it over the background. The background can be a video OR a still image (auto-detected, looped to match foreground length).

- `<color>` defaults to `green`. Named colors, `#RRGGBB`, or `0xRRGGBB`
- `<similarity>` (0..1, default 0.3) — how close a pixel must be to count as the key color
- `<blend>` (0..1, default 0.1) — soft-edge amount; 0 = hard cut, higher = softer

Audio is taken from the background by default (the "scene"). Override with `preferForegroundAudio=true` if the foreground holds the voice.

### Stabilize shaky footage (implemented)

```bash
npx -y @makemyclip/editor stabilize <input> [<shakiness>] [<smoothing>] [<accuracy>] [<zoom>]
```

Two-pass `vidstab`: pass 1 (`vidstabdetect`) analyzes motion and writes a transforms file; pass 2 (`vidstabtransform`) warps each frame to follow a smoothed camera path. Defaults are sensible (5, 10, 9, 5) — bump `shakiness` for very erratic input, `smoothing` for a more cinematic feel, `zoom` to hide warp borders.

Requires `vidstab`-enabled ffmpeg. The bundled `ffmpeg-static` includes it; the tool fails with a clear error otherwise.

### Open the local UI (implemented)

```bash
npx -y @makemyclip/editor ui
```

Starts a tiny local server on `http://127.0.0.1:5573` and opens your browser. The UI renders the session log (every op the agent has run), shows result paths and timestamps, and lets the user click an op to play its output. Useful as a companion to the chat-driven workflow — the user can watch the session evolve in real time and check outputs without touching the terminal.

The UI is local-only and read-mostly in v0.1; manual editing controls and a visual timeline land in later milestones.

### Session safety — snapshot, undo, inspect, delete (implemented)

Every successful tool call is logged to `$MAKEMYCLIP_WORKSPACE/session.json`. The agent can inspect that log, snapshot the current state, undo, or remove individual ops.

```bash
npx -y @makemyclip/editor snapshot [<label>]            # Save the current session as <label>.json (default: snap-<N>)
npx -y @makemyclip/editor undo [<snapshotLabel>]        # Pop the last op, OR restore a named snapshot
npx -y @makemyclip/editor inspect [<limit>]             # Show recent ops with one-line summaries
npx -y @makemyclip/editor delete <id> [<removeFile>]    # Remove an op (and optionally unlink its output file)
```

These are the recovery loop the council called must-haves. Snapshot before any uncertain edit; undo if it didn't land right; inspect to remember what you did.

## Safety

- FFmpeg is spawned with arguments as an array — no shell interpolation, no injection.
- All file paths resolve against a workspace directory by default.
- The skill makes no network calls beyond the one-time `npx` download of the package itself.

## Install

```bash
npx skills add MakeMyClip/editor
```

That's it.

## License

MIT. See [LICENSE](./LICENSE).
