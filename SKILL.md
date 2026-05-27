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

### Roadmap (not yet implemented)

These tools are designed and will land in this skill as they ship:

| Tool | What it will do |
|---|---|
| `zoom_pan` | Ken Burns / focus zoom on a region |
| `add_audio` | Background music, voiceover overlay |
| `transition` | Crossfade, cut, dip-to-black |
| `render` | Export to MP4 / MOV / WebM with codec control |

Until a tool ships, calling `npx -y @makemyclip/editor <toolname>` will return an unknown-command error — don't promise the user functionality that isn't here yet.

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
