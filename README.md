<p align="center">
  <img src="./logo.png" alt="MakeMyClip Editor" width="128" />
</p>

# MakeMyClip Editor

**The open-source AI video editor — drive FFmpeg with natural language, a CLI, or a browser UI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node 24+](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](./package.json)
[![Tests: 356 passing](https://img.shields.io/badge/tests-356%20passing-brightgreen)](#)
[![Telemetry: none](https://img.shields.io/badge/telemetry-none-brightgreen)](#)

> **Last updated:** May 2026 · **Status:** v0.6 — feature-complete local editing · **License:** [MIT](./LICENSE) (code) + GPL (bundled FFmpeg binary)

---

## What is MakeMyClip Editor?

MakeMyClip Editor is an open-source, local-first video editor that you operate by chatting with an AI agent, scripting a CLI, or dragging clips in a browser-based visual timeline. It wraps FFmpeg in 19 deterministic editing tools that any large language model can call, ships as a [Claude Code](https://claude.com/claude-code) skill, and stores every edit as inspectable JSON. No cloud, no account, no telemetry — the editor runs entirely on your machine.

## Quick facts

| | |
|---|---|
| **Editing model** | Agent-driven — an LLM calls 19 typed editing tools (not generative AI) |
| **Backend** | [FFmpeg](https://ffmpeg.org/) (bundled via `ffmpeg-static`) |
| **Tools shipping in v0.6** | 19 (trim, split, concat, transition, add_text, add_captions, add_title_card, chroma_key, silence_remove, highlight_reel, render, …) |
| **Surfaces** | [Claude Code](https://claude.com/claude-code) skill, `clip` CLI, browser UI (`clip ui`) |
| **AI integration** | Anthropic via [Vercel AI SDK](https://ai-sdk.dev/) — works with any model the SDK supports, or any agent that can shell out |
| **Storage** | Local — workspace folder with `session.json`, `chat.json`, snapshots, and output files |
| **Privacy** | Zero telemetry, zero network calls in the core (AI generation features opt-in) |
| **Languages** | TypeScript (Node 24+), React (browser UI) |
| **Tests** | 356 passing |
| **License** | MIT for the editor source; GPL for the bundled FFmpeg binary (subprocess-isolated) |

## Why MakeMyClip Editor

Existing tools force a tradeoff that does not need to exist:

- **iMovie / CapCut / DaVinci Resolve** are mouse-and-timeline desktop apps. They cannot be driven by an AI agent, scripted in CI, or version-controlled.
- **Descript** is closed-source, cloud-based, and rewrites audio with generative AI you cannot inspect.
- **Runway / Pika / Luma** generate video from text — useful for VFX, useless for assembling a 90-second product demo from screen recordings you already have.
- **Raw FFmpeg** is deterministic and free, but the surface is hostile to LLMs: cryptic filter graphs, no session model, no undo, no tool catalog.

MakeMyClip Editor closes the gap: **deterministic FFmpeg editing with a 19-tool catalog any agent can call, a session log it can inspect, and a browser UI a human can drive when the agent goes off-script.**

## How it compares

Different editors win at different jobs. The two tables below cut the same comparison two ways: **what features each tool has**, then **which jobs each tool is the right pick for**. Legend: ✅ great fit · ⚠️ works but not the best · ❌ doesn't fit.

### Feature matrix

| Feature | MakeMyClip Editor | iMovie / CapCut | Descript | Runway / Pika | Raw FFmpeg |
|---|:---:|:---:|:---:|:---:|:---:|
| Agent-driven (chat to edit) | ✅ | ❌ | ⚠️ | ❌ | ❌ |
| Open-source (MIT) | ✅ | ❌ | ❌ | ❌ | LGPL/GPL |
| Local-only (no cloud) | ✅ | ✅ | ❌ | ❌ | ✅ |
| Deterministic output (no AI generation) | ✅ | ✅ | ✅ | ❌ | ✅ |
| Free forever | ✅ | ✅ | freemium | paid | ✅ |
| Programmable CLI | ✅ | ❌ | ❌ | API | ✅ |
| Visual timeline UI | ✅ | ✅ | ✅ | ✅ | ❌ |
| Snapshot & undo | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| Inspectable session log (JSON) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Works as a [Claude Code](https://claude.com/claude-code) skill | ✅ | ❌ | ❌ | ❌ | manual |
| Stream-copy for lossless cuts | ✅ | ⚠️ | ⚠️ | ❌ | ✅ |
| Zero telemetry | ✅ | ❌ | ❌ | ❌ | ✅ |

### Use-case matrix — which tool is the right pick?

| Job to be done | MakeMyClip Editor | iMovie / CapCut | Descript | Runway / Pika | Raw FFmpeg |
|---|:---:|:---:|:---:|:---:|:---:|
| Trim screen recordings to highlights | ✅ | ✅ | ✅ | ❌ | ✅ |
| Assemble a product demo from N clips + title cards | ✅ | ✅ | ⚠️ | ❌ | ⚠️ |
| Add script-provided timed captions | ✅ | ⚠️ | ✅ | ❌ | ⚠️ |
| Auto-transcribe & edit text-as-video | ⚠️ (bring transcript) | ⚠️ | ✅ | ❌ | ❌ |
| Auto-cut silence from a recording | ✅ | ❌ | ✅ | ❌ | ⚠️ |
| Chroma-key / green-screen compositing | ✅ | ⚠️ (basic) | ⚠️ | ⚠️ | ✅ |
| Generate b-roll / VFX shots from a prompt | ❌ | ❌ | ⚠️ | ✅ | ❌ |
| Multi-track audio mixing with effects | ❌ | ⚠️ | ✅ | ❌ | ⚠️ |
| Frame-accurate color grading | ⚠️ (basic adjust) | ⚠️ | ❌ | ❌ | ✅ |
| Drive editing from an AI agent in natural language | ✅ | ❌ | ⚠️ | ⚠️ | ❌ |
| Run as a scriptable CI pipeline | ✅ | ❌ | ❌ | ⚠️ (API) | ✅ |
| Long-form (>30 min) projects with hundreds of clips | ⚠️ | ✅ | ✅ | ❌ | ✅ |
| Edit on Linux / headless / fully offline | ✅ | ❌ | ❌ | ❌ | ✅ |

Honest summary: **MakeMyClip Editor is the right pick when you want deterministic, scriptable editing that an AI agent can drive end-to-end.** It is *not* the right pick when you want generative video (Runway), text-as-video transcript editing (Descript), or a heavy multi-track NLE (DaVinci Resolve, Premiere).

## Quick start

### Option 1 — as a [Claude Code](https://claude.com/claude-code) skill (recommended for chat-driven editing)

```bash
npx skills add MakeMyClip/editor
```

Then ask Claude in plain English:

```
You: Trim demo.mp4 to seconds 5–20, prepend a black title card saying
     "Q2 product demo", and render to 1080p.

Claude: *calls trim → add_title_card → render → returns demo-final.mp4*
```

No global install, no config edits, no client restart. The skill auto-discovers triggers and shells out to the CLI on demand (`npx -y` downloads the package on first use, caches after).

### Option 2 — as a CLI

```bash
npm i -g @makemyclip/editor
clip --help
```

```bash
# Example: assemble a product video from three screen recordings
clip ingest demo1.mp4
clip ingest demo2.mp4
clip ingest demo3.mp4
clip add_title_card demo1.mp4 "Demo 1: Recording"
clip concat demo1-with-card.mp4 demo2.mp4 demo3.mp4
clip render concat-output.mp4 mp4 23 fast 1920
```

### Option 3 — as a browser UI

```bash
clip ui   # opens http://127.0.0.1:5573 in your default browser
```

Visual workflow with drag-drop file import, a horizontal timeline of every clip the session has produced, a render queue you drag clips into, a chat sidebar that talks to the same agent that drives the skill, snapshot/undo buttons, and keyboard shortcuts (⌘Z undo, ⌘S snapshot, ⌘⇧N new op, Esc cancel).

**Optional:** set `ANTHROPIC_API_KEY` in the shell that runs `clip ui` to enable the chat panel. The rest of the UI works without an API key.

## Capabilities — 19 tools in v0.6

Tools group into five categories. Every tool is a single CLI command, a single MCP-style entry in the [tool registry](src/ui/tool-registry.ts), and a single form in the browser UI.

| Category | Tools | What they do |
|---|---|---|
| **Cut & arrange** | `trim`, `split`, `concat`, `transition` | Stream-copy cuts, frame-accurate splits, multi-clip stitching, 12 transition kinds (fade, dissolve, 4-direction wipe, left/right slide, circle-open / circle-close) |
| **Text & captions** | `add_text`, `add_title_card`, `add_captions` | Overlay text, prepend color cards with centered titles, burn N timed caption cues |
| **Visual primitives** | `transform` (crop/rotate/scale/flip), `adjust` (brightness/contrast/saturation/volume), `zoom_pan` (Ken Burns), `overlay` (picture-in-picture), `speed` (slow-mo / fast-forward / reverse) | The iMovie adjustment panel + zoom, in primitive form |
| **Composites & specialty** | `highlight_reel`, `silence_remove`, `chroma_key`, `stabilize` | Multi-segment extraction with transitions, auto-silence cutting, green-screen compositing, two-pass vidstab |
| **Output & I/O** | `ingest` (probe + register), `preview` (single-frame JPEG), `render` (re-encode to mp4 / mov / webm), `add_audio` (music + voiceover with ducking) | Bring media in, peek at frames, ship the final cut |

Plus four meta-operations not in the tool registry: `snapshot` (save the session), `undo` (pop the last op or restore a snapshot), `inspect` (one-line op summaries), `delete` (remove an op from the log).

## Example: assemble a product video

The workflow MakeMyClip Editor v0.3+ unblocked — five screen recordings, title cards between them, one render:

**Via chat (browser UI or Claude Code):**

> Import these five screen recordings. Trim each to the most interesting 8–12 seconds. Add black title cards saying "Demo 1: Inbox", "Demo 2: Search", "Demo 3: Compose", "Demo 4: Calendar", "Demo 5: Reports" between them. Concat in order. Render to 1080p mp4.

The agent runs roughly: `ingest × 5` → `trim × 5` → `add_title_card × 5` → `concat` → `render`. Output drops into the workspace folder, every step is logged to `session.json`, and you can `undo` any of it.

**Via the visual timeline (browser UI):**

1. Drag the five recordings into the import bar at the top
2. Pick **Trim** from "+ New op" for each one
3. Pick **Add title card** between each trim
4. Drag the resulting clips into the "Render queue" track in the order you want
5. Click **Concat ▶**, then **Render** for the final mp4

**Via CLI scripts:** see [`examples/`](./examples/) for repeatable pipelines you can drop into CI.

## Architecture

```
Claude Code  →  skill triggers  →  npx -y @makemyclip/editor <tool>
                                           │
Browser UI   →  /api/tools/:name  →  TOOL_REGISTRY (19 tools)
                                           │
Chat panel   →  /api/chat  →  AI SDK + Anthropic + tool dispatch
                                           │
                                           ▼
                                  Tool handlers (TypeScript)
                                           │
                                           ▼
                                 FFmpeg subprocess (args as array, no shell)
                                           │
                                           ▼
                                 session.json (append-only op log)
```

The session is the source of truth: every editing operation appends one entry with `{ id, tool, args, result, timestamp }`. The CLI, browser UI, and chat panel all write through the same `appendOp()` path, so any combination of human + agent edits stays consistent.

- **Language:** TypeScript (Node 24+) and React 19 (browser UI)
- **Timeline schema:** [Zod](https://zod.dev/) (shared with the [MakeMyClip.com](https://makemyclip.com) web app)
- **Subprocess:** [execa](https://github.com/sindresorhus/execa) — args as an array, no shell injection
- **FFmpeg:** bundled via `ffmpeg-static`, with `MAKEMYCLIP_FFMPEG_PATH` override or system-binary fallback
- **AI SDK:** [Vercel AI SDK](https://ai-sdk.dev/) + `@ai-sdk/anthropic` (chat panel only)
- **UI:** Hono server + Vite + React, plain CSS

## Frequently asked questions

### Is MakeMyClip Editor free?
Yes — MIT-licensed, free forever for local editing. There is no paid tier, no signup, and no upsell in the editor itself. Paid AI-generation features (voice synthesis, music libraries, stock footage) will live on [MakeMyClip.com](https://makemyclip.com) when they ship, and require explicit opt-in via a separate `@makemyclip/generation` package.

### Does it require an API key?
Only the chat panel needs `ANTHROPIC_API_KEY`. The CLI, the browser UI's visual editing, the Claude Code skill, and every editing tool work without any API key — Claude Code provides its own credentials when invoking the skill, and the CLI calls FFmpeg directly.

### Does it send my video files anywhere?
No. The editor makes zero network calls in its core. The optional chat panel sends conversation text (not video files) to Anthropic's API when enabled. The `@makemyclip/generation` package (for voice / music / stock) requires explicit opt-in and is the only path that talks to external services.

### How does it compare to Descript?
Descript edits text-as-video using generative AI to rewrite audio. MakeMyClip Editor edits video as video, using deterministic FFmpeg operations — every cut is exact, lossless where possible, and reproducible. Descript is closed-source and cloud-only; MakeMyClip Editor is MIT and local. Different tools for different needs.

### Can I use it without Claude Code?
Yes. The `clip` CLI and `clip ui` browser app are first-class surfaces. The Claude Code skill is one of three entry points — the editor itself is agnostic to which agent (or human) drives it.

### Does it support MCP (Model Context Protocol)?
Not yet in v0.6. The MCP server is deferred to a later milestone — the skill + CLI path covers the primary audience (Claude Code users) with one-command setup. The 19-tool registry is already MCP-shaped (`{ name, schema, fn }`), so adding the MCP transport is small when the demand surfaces.

### What's the license situation with the bundled FFmpeg?
The MakeMyClip Editor source code is [MIT](./LICENSE). The bundled FFmpeg binary (via `ffmpeg-static`) is GPL-licensed because it includes codecs like libx264 and libx265. This is fine for personal use, open-source projects, internal company use, server-side SaaS, and most commercial desktop products — your own code stays MIT, and invoking FFmpeg as a subprocess keeps the GPL terms confined to the binary, not your application code. For LGPL-only or custom-build requirements (e.g. iOS App Store), set `MAKEMYCLIP_FFMPEG_PATH` to your own binary and the bundled one is ignored.

### What platforms does it run on?
macOS, Linux, and Windows — anywhere Node 24+ and FFmpeg run. The browser UI is local (`127.0.0.1`); no internet connection is required to edit.

### How do I extend it with my own tools?
Add a file in `src/tools/<name>.ts` exporting a Zod input schema and a handler, register it in [`src/ui/tool-registry.ts`](src/ui/tool-registry.ts), and the tool becomes available in the CLI, the browser UI's tool picker, and the chat panel's agent. See [AGENTS.md](./AGENTS.md) for conventions and [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution flow.

### Is it production-ready?
v0.6 is feature-complete for local editing — 19 tools, 356 tests passing, browser UI shipped, chat panel shipped. We call it "almost production-ready" because the API surface is still pre-1.0 (tool schemas may change in minor ways before v1.0). Use it for real work; pin a version in CI.

## When to use it

✅ Great fit when you want to:

- Assemble product demos, screen recordings, tutorials, or social clips with an AI agent doing the labor
- Script repeatable video pipelines (one prompt = one clip; one CI run = one weekly social post)
- Share an inspectable timeline JSON with your team or version-control your edits
- Edit on a machine without an internet connection
- Avoid lock-in to a closed cloud editor

❌ Not the right tool for:

- Frame-accurate color grading or VFX work (use DaVinci Resolve)
- Multi-track audio mixing with effects chains (use Reaper, Logic, or Audition)
- Generative-AI video creation (use Runway, Pika, Luma)
- Long-form (>30 minute) projects with hundreds of clips

## Roadmap

- **v0.6 (current)** — chat panel + per-card scrub
- **v0.7** — model picker, SSE for live session updates, AI Elements / shadcn migration
- **v1.0** — frozen tool schemas, MCP transport, published Anthropic skill, docs site
- **v2+** — desktop app (Electron), cloud rendering via [MakeMyClip.com](https://makemyclip.com)

The full UI-side milestone log lives in PR descriptions on the [GitHub repo](https://github.com/MakeMyClip/editor/pulls?q=is%3Apr+label%3Aui).

## Acknowledgments

Built on the work of:
- [FFmpeg](https://ffmpeg.org/) — the engine
- [Vercel AI SDK](https://ai-sdk.dev/) — agent loop + streaming
- [Anthropic Claude](https://www.anthropic.com/) — the model in the chat panel
- [Zod](https://zod.dev/) — tool schemas
- [Hono](https://hono.dev/) + [Vite](https://vite.dev/) + [React](https://react.dev/) — browser UI

## License

[MIT](./LICENSE) — use it, fork it, ship it.

## Links

- **Website:** [makemyclip.com](https://makemyclip.com)
- **Claude Code skill page:** [skills.sh/MakeMyClip/editor](https://skills.sh/MakeMyClip/editor)
- **npm:** [`@makemyclip/editor`](https://www.npmjs.com/package/@makemyclip/editor)
- **GitHub:** [MakeMyClip/editor](https://github.com/MakeMyClip/editor)
- **Issues & feature requests:** [GitHub Issues](https://github.com/MakeMyClip/editor/issues)
- **For AI agents:** [llms.txt](./llms.txt) — machine-readable summary
