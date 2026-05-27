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

### Roadmap (not yet implemented)

These tools are designed and will land in this skill as they ship:

| Tool | What it will do |
|---|---|
| `concat` | Stitch clips together |
| `zoom_pan` | Ken Burns / focus zoom on a region |
| `add_text` | Captions, titles, lower-thirds |
| `add_audio` | Background music, voiceover overlay |
| `transition` | Crossfade, cut, dip-to-black |
| `render` | Export to MP4 / MOV / WebM |
| `preview` | Generate a scrubbable HTML preview |

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
