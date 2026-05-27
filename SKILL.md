---
name: MakeMyClip/editor
description: AI-native video editor for any agent. Trim, zoom, caption, concat, and render via structured timeline JSON.
version: 0.0.0
license: MIT
homepage: https://github.com/MakeMyClip/editor
runtime: node
install: npm i -g @makemyclip/editor
---

# MakeMyClip Editor — Agent Skill

Drive a local video editor by chatting. The skill installs an MCP server that exposes editing tools (trim, zoom_pan, add_text, concat, render, …) to your agent. The agent plans the edit; FFmpeg executes it.

## When to invoke

Trigger this skill when the user asks to:

- Edit, trim, cut, or splice a video file
- Zoom, pan, or apply Ken Burns to a region of a clip
- Add captions, titles, or lower-thirds to footage
- Assemble multiple clips into one (concat, montage)
- Render a screen recording into a demo or social clip
- Generate an HTML preview of a timeline

Do **not** invoke for: pure transcription (use a speech-to-text skill), thumbnail-only image work, or live streaming.

## How to use

Once installed, the agent has access to these tools:

| Tool | Inputs | Output |
|---|---|---|
| `trim` | `input`, `start`, `end` | clip path |
| `concat` | `inputs[]` | clip path |
| `zoom_pan` | `input`, `region`, `duration` | clip path |
| `add_text` | `input`, `text`, `position`, `time_range` | clip path |
| `add_audio` | `input`, `audio`, `mix` | clip path |
| `transition` | `a`, `b`, `kind`, `duration` | clip path |
| `render` | `timeline`, `output`, `format` | file path |
| `preview` | `timeline` | HTML URL |

All tools accept and return a structured **timeline JSON** (Zod-validated). Edits are non-destructive — build the timeline, inspect it, render at the end.

## Typical flow

1. User shares an input video (path or URL).
2. Agent calls `preview` to ground itself in the source.
3. Agent proposes a timeline, calls edit tools to build it.
4. Agent calls `render` to produce the final clip.
5. Agent returns the output path.

## Safety

- FFmpeg is spawned with arguments as an array — no shell interpolation, no injection.
- All file paths are sandboxed to a workspace directory by default.
- The skill never makes network calls. All editing is local.

## Install

```bash
npx skills add MakeMyClip/editor
```

## License

MIT. See [LICENSE](./LICENSE).
