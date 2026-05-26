# MakeMyClip Editor

**AI-native video editor — talk to make video.**

Trim, zoom, caption, and assemble clips from any AI agent (Claude, Cursor, Copilot). Delivered as an [MCP](https://modelcontextprotocol.io) server + [agent skill](https://skills.sh).

> Status: pre-alpha. Repo reserved, design locked, code landing soon. Star to follow along.

---

## What it is

An open-source video editor you drive by chatting with an AI agent. No timeline UI to learn — describe the edit in plain English and the agent calls the editor's tools to do it.

```
You:    "Trim the first 12 seconds, zoom on the cursor at 0:34, and add a caption."
Agent:  *calls trim, zoom_pan, add_text → renders → returns clip.mp4*
```

Under the hood it's a thin, safe wrapper around FFmpeg with a structured timeline schema. The agent does the planning; the editor does the rendering.

## Why

Existing video editors are mouse-and-timeline. Existing AI video tools are black-box generators. Neither fits the workflow of a developer or founder who wants to:

- turn a 5-minute screen recording into a 45-second product demo,
- caption and zoom a tutorial without opening Premiere,
- assemble a social clip from raw footage in one prompt.

This editor is the missing piece: **deterministic, local, scriptable editing** that any AI agent can drive.

## Install

```bash
# via the skills registry (recommended)
npx skills add MakeMyClip/editor

# or directly via npm
npm i -g @makemyclip/editor
```

This installs the `clip` CLI and registers the MCP server with your Claude / Cursor / Copilot config. From then on, just chat.

## When to use it

✅ Use it when you want to:
- Edit screen recordings, demos, tutorials, or social clips with an AI agent
- Script repeatable video pipelines (one prompt = one clip)
- Share an editable timeline JSON with your team

❌ Don't use it (yet) for:
- Frame-accurate color grading or VFX work
- Multi-track audio mixing
- Long-form (>30 min) projects

## Capabilities (v1)

| Tool | What it does |
|---|---|
| `trim` | Cut clips by timecode |
| `concat` | Stitch clips together |
| `zoom_pan` | Ken Burns / focus zoom on a region |
| `add_text` | Captions, titles, lower-thirds |
| `add_audio` | Background music, voiceover overlay |
| `transition` | Crossfade, cut, dip-to-black |
| `render` | Export to MP4 / MOV / WebM |
| `preview` | Generate an HTML scrubbable preview |

All edits are non-destructive — the agent builds a timeline JSON, you can inspect and tweak it, then render.

## Architecture

```
┌─────────────────────────┐       ┌────────────────────────┐
│  AI Agent               │ MCP   │  MakeMyClip Editor      │
│  (Claude / Cursor / …)  │ ◄───► │  - timeline schema      │
└─────────────────────────┘       │  - tool handlers        │
                                  │  - FFmpeg runner        │
                                  │  - HTML preview         │
                                  └────────────────────────┘
                                            │
                                            ▼
                                       ffmpeg binary
```

- **Language:** TypeScript (Node 20+)
- **MCP framework:** `@modelcontextprotocol/sdk`
- **Timeline schema:** Zod (shareable with the [MakeMyClip.com](https://makemyclip.com) web app)
- **Subprocess:** `execa` — args as an array, no shell injection
- **FFmpeg:** bundled via `@ffmpeg-installer/ffmpeg`, or use system binary

## Free vs paid

The editor is **MIT licensed and free forever** for local editing. Anything FFmpeg can do, this does for free.

When you want **AI-generated content** — voiceover, music, b-roll, stock footage, premium templates — the editor calls the [MakeMyClip.com](https://makemyclip.com) generation API, which is metered. Local editing never requires an account.

| Free & open source | Paid (MakeMyClip.com) |
|---|---|
| All FFmpeg editing | AI voiceover generation |
| Trim, zoom, caption, render | AI music & b-roll |
| Timeline JSON + schema | Premium templates |
| HTML preview | Cloud rendering |
| Basic templates | Team workspaces |

## License

[MIT](./LICENSE) — use it, fork it, ship it.

## Links

- Website: [makemyclip.com](https://makemyclip.com)
- Skill page: [skills.sh/MakeMyClip/editor](https://skills.sh/MakeMyClip/editor)
- npm: [`@makemyclip/editor`](https://www.npmjs.com/package/@makemyclip/editor)
- Issues & feature requests: [GitHub Issues](https://github.com/MakeMyClip/editor/issues)
