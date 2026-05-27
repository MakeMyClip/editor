# MakeMyClip Editor

**AI-native video editor — talk to Claude to make video.**

Trim, zoom, caption, and assemble clips by asking Claude. Ships as a [Claude Code skill](https://skills.sh) + a `clip` CLI for direct use from terminal, scripts, or any agent that can shell out.

> Status: pre-alpha. Walking skeleton (skill + `trim` tool) is shipping; more tools landing iteratively. Star to follow along.

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

This editor is the missing piece: **deterministic, local, scriptable editing** that any AI agent can drive. Every edit is a structured timeline document the agent can inspect, version, and hand off — not an opaque sequence of FFmpeg commands.

## Install

**Claude Code** — one command:

```bash
npx skills add MakeMyClip/editor
```

No global install, no config edits, no client restart. The skill auto-discovers triggers and shells out to the CLI on demand (`npx -y` downloads the package on first use, cached after).

**Terminal, scripts, CI:**

```bash
npm i -g @makemyclip/editor
```

Then use the `clip` CLI directly. Run `clip --help` for usage.

> MCP server for other clients (Cursor, Claude Desktop, Continue) is on the roadmap — see the [project shape](./AGENTS.md) for what's currently in vs out.

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
Claude Code  →  skill auto-discovery  →  npx -y @makemyclip/editor <tool>
                                              │
                                              ▼
                                         clip CLI (tool handlers)
                                              │
                                              ▼
                                    FFmpeg subprocess (stream-copy / filter)
```

The skill is intent-matching markdown; the CLI is the single execution surface. No persistent server, no daemon, no client-specific wiring — just one process per invocation.

- **Language:** TypeScript (Node 24+)
- **Timeline schema:** Zod (shareable with the [MakeMyClip.com](https://makemyclip.com) web app)
- **Subprocess:** `execa` — args as an array, no shell injection
- **FFmpeg:** bundled via `ffmpeg-static`, with `$MAKEMYCLIP_FFMPEG_PATH` override or system-binary fallback

## Free & open source

The editor is **MIT licensed and free forever** for local editing. Anything FFmpeg can do, this does for free — no account, no telemetry, no limits.

Paid AI-generation features (voice, music, stock, premium templates) will live on [MakeMyClip.com](https://makemyclip.com) when ready.

## License

The MakeMyClip Editor source code is [MIT](./LICENSE) licensed — use it, fork it, ship it.

The bundled FFmpeg binary (via `ffmpeg-static`) is **GPL** licensed because it includes codecs like libx264 and libx265. This is fine for personal use, open-source projects, internal company use, server-side SaaS, and most commercial desktop products — your own code stays MIT, and the subprocess invocation pattern keeps the GPL terms confined to the FFmpeg binary itself, not your application code.

If your situation requires an LGPL-only or custom FFmpeg build (e.g. strict no-copyleft enterprise policy, iOS App Store distribution), set `MAKEMYCLIP_FFMPEG_PATH` to your own binary and the bundled one will be ignored.

## Links

- Website: [makemyclip.com](https://makemyclip.com)
- Skill page: [skills.sh/MakeMyClip/editor](https://skills.sh/MakeMyClip/editor)
- npm: [`@makemyclip/editor`](https://www.npmjs.com/package/@makemyclip/editor)
- Issues & feature requests: [GitHub Issues](https://github.com/MakeMyClip/editor/issues)
