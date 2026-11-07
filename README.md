<p align="center">
  <img src="./logo.png" alt="MakeMyClip Editor" width="128" />
</p>

<h1 align="center">MakeMyClip Editor</h1>

<p align="center"><b>FFmpeg you can talk to.</b><br/>
The open-source AI video editor for Claude Code and any MCP client: remove silence, edit by transcript, add captions, and export to Final Cut Pro, DaVinci Resolve or Premiere Pro. Everything runs on your machine.</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/node-%E2%89%A524-brightgreen" alt="Node 24+"></a>
  <a href="https://www.npmjs.com/package/@makemyclip/editor"><img src="https://img.shields.io/npm/v/@makemyclip/editor.svg" alt="npm"></a>
  <a href="https://skills.sh/makemyclip/editor"><img src="https://skills.sh/b/makemyclip/editor" alt="skills.sh"></a>
  <img src="https://img.shields.io/badge/tests-741%20passing-brightgreen" alt="Tests: 741 passing">
  <img src="https://img.shields.io/badge/telemetry-none-brightgreen" alt="Telemetry: none">
</p>

<p align="center">
  <img src="./docs/hero.png" alt="MakeMyClip Editor — chat-driven video editing demo (real screencast coming soon)" width="720" />
</p>

**MakeMyClip Editor is a free, open-source (MIT) video editor that AI agents drive.** You ask Claude to edit a recording; it calls the editor's tools, and FFmpeg and a local whisper.cpp do the work on your computer. It ships as a Claude Code skill, the `clip` CLI, an MCP server, and a browser timeline editor. No cloud upload, no account, no API key, no telemetry, no generative AI.

> *"Cut the repeated takes and the pauses out of talk.mp4, caption it, and give me a DaVinci Resolve project."*
>
> Claude transcribes the recording locally, cuts the earlier take of each repeated phrase and the silences, captions the speech, flags any cut that may clip a word, and writes `talk.fcpxml`. Each edit is one undoable step on a timeline you can open in the browser and take over.

---

## What it does

Version 0.4.0 turns a raw talking-head recording into a clean, captioned cut that opens in a pro editor:

| Feature | What it does | CLI |
|---|---|---|
| **Remove silence** | Cuts the pauses out of a recording, with a sensitivity control and a dry run | `clip timeline silence` |
| **Local transcription** | Word-level transcript with timeline times, from whisper.cpp on your machine | `clip timeline transcribe` |
| **Edit by transcript** | Cuts a range of words out of a clip | `clip timeline cut-words` |
| **Remove repeated takes** | Cuts the earlier take of each phrase said twice in a row | `clip timeline remove-retakes` |
| **Captions** | Burned-in captions timed to the words, as short phrases or one word at a time | `clip timeline captions` |
| **Cut check** | Flags cuts where a word may be clipped, with a contact sheet of the frames on each side | `clip timeline check` |
| **Export to Final Cut Pro and DaVinci Resolve** | FCPXML 1.10 project | `clip timeline export --format fcpxml` |
| **Export to Premiere Pro** | Final Cut Pro 7 XML project, captions as `.srt` files | `clip timeline export --format xmeml` |
| **Render** | mp4 of the finished cut | `clip timeline export` |

All of it works from chat (the Claude Code skill or the MCP server), the CLI, and the browser UI; the cut check isn't in the UI yet. Every edit is one step on a non-destructive timeline that `undo` and `redo` walk through. Underneath sit [19 single-file FFmpeg tools](#all-19-tools) for everything else: trim, split, concat, transitions, text and title cards, zoom/pan, overlay, speed, color, chroma key, stabilize, and render.

---

## Install in 30 seconds

**As a [Claude Code](https://claude.com/claude-code) skill** (chat-driven, no global install):

```bash
npx skills add MakeMyClip/editor
```

**As a CLI** (for scripts and CI):

```bash
npm i -g @makemyclip/editor
clip --help
```

**As a browser UI** (dark visual timeline editor):

```bash
clip ui   # opens http://127.0.0.1:5573
```

**As an MCP server** (drive it from Claude Desktop / Cursor / any MCP client — no API key, on your existing Claude):

```jsonc
// claude_desktop_config.json → "mcpServers"
{
  "makemyclip-editor": {
    "command": "npx",
    "args": ["-y", "@makemyclip/editor", "mcp"],
    "env": {
      "MAKEMYCLIP_WORKSPACE": "/path/to/your/media",
      "MAKEMYCLIP_WHISPER_MODEL": "/path/to/ggml-base.en.bin"
    }
  }
}
```

The Claude Code skill auto-discovers triggers and shells out via `npx -y` on demand. The MCP server exposes the timeline tools (show / edit / check / transcribe / undo / redo / export) over stdio; media stays confined to `MAKEMYCLIP_WORKSPACE`, and `MAKEMYCLIP_WHISPER_MODEL` is only needed for transcription and captions. Everything runs locally and offline — no API key.

**Optional: local transcription** (for editing by transcript, removing retakes, and captions):

```bash
brew install whisper-cpp   # macOS; other platforms: https://github.com/ggml-org/whisper.cpp
export MAKEMYCLIP_WHISPER_MODEL=/path/to/ggml-base.en.bin
```

Download a model such as `ggml-base.en.bin` from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), and set `MAKEMYCLIP_WHISPER_PATH` if `whisper-cli` isn't on your `PATH`. The editor never downloads a model itself.

---

## Quick start: clean up a talking-head recording

In Claude Code (with the skill) or Claude Desktop (with the MCP server), ask:

> *Clean up talk.mp4: remove the repeated takes and the pauses, add captions, check the cuts, then export an mp4 and a Final Cut Pro project.*

The same steps from the CLI:

```bash
clip timeline new
clip timeline add-media talk.mp4             # prints the clip id, e.g. clip_ec2f047d
clip timeline transcribe clip_ec2f047d       # each word with its time, plus repeated takes
clip timeline remove-retakes clip_ec2f047d   # cut the earlier take of each repeated phrase
clip timeline silence clip_ec2f047d          # cut the pauses
clip timeline captions                       # caption every transcribed clip
clip timeline check --sheet cuts.jpg         # flag cuts that may clip a word
clip timeline export talk-clean.mp4          # render the cut
clip timeline export talk.fcpxml             # or open it in Final Cut Pro / DaVinci Resolve
clip timeline export talk.xml                # or in Premiere Pro
```

A cut splits the clip into pieces: the first keeps its id, and `clip timeline show` lists the rest, so run `silence` on each piece you want tightened (in chat, the agent does this for you). `clip timeline undo` reverses any step.

---

## Another example: a product demo from screen recordings

Five screen recordings → one polished product demo. Type this into Claude Code (or Claude Desktop, via the MCP server):

> *Import these five recordings. Trim each to the most interesting 8–12 seconds. Add black title cards saying "Demo 1: Inbox", "Demo 2: Search", "Demo 3: Compose", "Demo 4: Calendar", "Demo 5: Reports" between them. Concat in order. Render to 1080p mp4.*

The agent runs roughly `ingest × 5` → `trim × 5` → `add_title_card × 5` → `concat` → `render`. The final mp4 lands in your workspace folder, every step is appended to `session.json`, and you can `⌘Z` any of it.

Or skip the chat and do it from a script:

```bash
clip ingest demo1.mp4
clip trim demo1.mp4 5 20
clip add_title_card demo1-trim.mp4 "Demo 1: Inbox"
clip concat demo1-with-card.mp4 demo2.mp4 demo3.mp4
clip render concat-output.mp4 mp4 23 fast 1920
```

Same registry, same session log, same output.

---

## All 19 tools

19 tools across 5 categories, four surfaces (Claude Code skill, CLI, browser UI, MCP server), one shared op log.

| Category | Tools |
|---|---|
| **Cut & arrange** | `trim`, `split`, `concat`, `transition` (12 kinds) |
| **Text & captions** | `add_text`, `add_title_card`, `add_captions` |
| **Visual primitives** | `transform`, `adjust`, `zoom_pan` (Ken Burns), `overlay`, `speed` |
| **Composites & specialty** | `highlight_reel`, `silence_remove`, `chroma_key`, `stabilize` |
| **Output & I/O** | `ingest`, `preview`, `render`, `add_audio` |

Plus four meta-ops not in the registry: `snapshot`, `undo`, `inspect`, `delete`.

The browser UI is a dark timeline editor: drag-drop import, a monitor (the composited frame at the playhead), an editable timeline (select a clip to trim / split / move / transition / remove, cut its silences, or cut words and retakes from its transcript), captions from transcripts, one-click export (an mp4, or a project for Final Cut Pro, DaVinci Resolve or Premiere Pro), timeline undo/redo, snapshot, and keyboard shortcuts.

---

## Why it exists

Existing tools force a tradeoff that doesn't need to exist:

- **iMovie / CapCut / DaVinci Resolve** — mouse-and-timeline desktops. Can't be driven by an agent, scripted in CI, or version-controlled.
- **Descript** — closed-source, cloud-based, rewrites audio with generative AI you can't inspect.
- **Runway / Pika / Luma** — generate video from text. Useful for VFX, useless for assembling a 90-second demo from recordings you already have.
- **Raw FFmpeg** — deterministic and free, but the surface is hostile to LLMs: cryptic filter graphs, no session model, no undo, no tool catalog.

MakeMyClip Editor closes the gap: **deterministic editing an agent can drive end to end (silence, transcript cuts, captions, export to pro editors) on a timeline it can inspect and a human can open and take over.**

<details>
<summary><b>Full comparison matrix</b> — features and use-cases vs. iMovie, Descript, Runway, raw FFmpeg</summary>

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
| Works as a Claude Code skill | ✅ | ❌ | ❌ | ❌ | manual |
| Stream-copy for lossless cuts | ✅ | ⚠️ | ⚠️ | ❌ | ✅ |
| Zero telemetry | ✅ | ❌ | ❌ | ❌ | ✅ |

### Use-case matrix

| Job to be done | MakeMyClip Editor | iMovie / CapCut | Descript | Runway / Pika | Raw FFmpeg |
|---|:---:|:---:|:---:|:---:|:---:|
| Trim screen recordings to highlights | ✅ | ✅ | ✅ | ❌ | ✅ |
| Assemble a product demo from N clips + title cards | ✅ | ✅ | ⚠️ | ❌ | ⚠️ |
| Add script-provided timed captions | ✅ | ⚠️ | ✅ | ❌ | ⚠️ |
| Transcribe & edit video by its transcript | ✅ (local whisper.cpp) | ⚠️ | ✅ | ❌ | ❌ |
| Auto-cut silence from a recording | ✅ | ❌ | ✅ | ❌ | ⚠️ |
| Finish the cut in Final Cut Pro, Resolve or Premiere | ✅ | ⚠️ | ✅ | ❌ | ❌ |
| Chroma-key / green-screen compositing | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ |
| Generate b-roll / VFX shots from a prompt | ❌ | ❌ | ⚠️ | ✅ | ❌ |
| Multi-track audio mixing with effects | ❌ | ⚠️ | ✅ | ❌ | ⚠️ |
| Drive editing from an AI agent in natural language | ✅ | ❌ | ⚠️ | ⚠️ | ❌ |
| Run as a scriptable CI pipeline | ✅ | ❌ | ❌ | ⚠️ (API) | ✅ |
| Long-form (>30 min) with hundreds of clips | ⚠️ | ✅ | ✅ | ❌ | ✅ |
| Edit on Linux / headless / fully offline | ✅ | ❌ | ❌ | ❌ | ✅ |

Legend: ✅ great fit · ⚠️ works but not the best · ❌ doesn't fit.

**Honest summary:** MakeMyClip Editor is the right pick when you want deterministic, scriptable editing that an AI agent can drive end-to-end. Not the right pick for generative video (Runway), a hosted transcript editor with collaboration and AI voice features (Descript), or a heavy multi-track NLE (DaVinci, Premiere) — though it can hand its cut to one.

</details>

<details>
<summary><b>Architecture</b> — four surfaces, one composition document, one append-only op log</summary>

```
Claude Code  →  skill triggers  →  npx -y @makemyclip/editor <tool | timeline …>
                                           │
Browser UI   →  /api/tools/:name · /api/timeline/verbs  →  registry + verb layer
                                           │
Claude Desktop →  clip mcp (MCP server)  →  timeline verbs
                                           │
                                           ▼
                                  Tool handlers (TypeScript)
                                           │
                                           ▼
                                 FFmpeg subprocess (args as array, no shell)
                                           │
                   ┌───────────────────────┴───────────────────────┐
                   ▼                                                 ▼
        Composition document                              session.json
        (non-destructive timeline,                        (append-only op log
         op-log undo/redo)                                 of every tool call)
```

Two layers of state, by design. The **composition document** is the source of truth for assembled edits: a non-destructive, multi-track timeline that `clip timeline`, the browser UI, and the agent (the Claude Code skill or the `clip mcp` server) all mutate through one op-aware path, with a coupled op log that powers undo/redo. **`session.json`** is an append-only op log of every tool invocation — `{ id, tool, args, result, timestamp }` — written through the same `appendOp()` path by the single-file tools (`clip trim`, `/api/tools/:name`, …); it is the audit trail and recovery layer. Both layers are written through one serialized path, so any combination of human + agent edits stays consistent.

**Build a composition end-to-end** (CLI shown; the browser UI and the agent — Claude Code or MCP — drive the same document):

```bash
clip timeline new                       # start an empty composition
clip timeline add-media intro.mp4       # ingest + append a clip
clip timeline add-media demo.mp4
clip timeline transition <afterClipId> fade 0.5
clip timeline show                      # inspect tracks, clips, timings
clip timeline export final.mp4          # compile the document to a render
```

Every edit is undoable (`clip timeline undo` / `redo`, `clip timeline log`), and `clip timeline at <sec>` / `frame <sec>` give an agent read-only eyes on the document. Run `clip timeline --help` for the full subcommand list.

- **Language:** TypeScript (Node 24+) and React 19 (browser UI)
- **Timeline schema:** [Zod](https://zod.dev/) (shared with the [MakeMyClip.com](https://makemyclip.com) web app)
- **Subprocess:** [execa](https://github.com/sindresorhus/execa) — args as an array, no shell injection
- **FFmpeg:** bundled via `ffmpeg-static`, with `MAKEMYCLIP_FFMPEG_PATH` override or system-binary fallback
- **Transcription:** optional, user-installed [whisper.cpp](https://github.com/ggml-org/whisper.cpp), run as a subprocess
- **MCP:** [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io/) — the `clip mcp` server (Claude Desktop / any MCP client)
- **UI:** Hono server + Vite + React, plain CSS

</details>

<details>
<summary><b>FAQ</b> — setup, capabilities, privacy, AI integration, comparisons, license</summary>

### Setup & installation

**Do I need FFmpeg installed separately?**
No. MakeMyClip Editor bundles FFmpeg via `ffmpeg-static`, so installing the npm package or running `npx skills add MakeMyClip/editor` is all you need. For your own FFmpeg build (LGPL-only, custom codecs, hardware acceleration), set `MAKEMYCLIP_FFMPEG_PATH` to its path and the bundled binary is ignored.

**What platforms does it run on?**
macOS, Linux, and Windows — anywhere Node 24+ runs. The browser UI binds to `127.0.0.1` and needs no internet connection.

**Can I use it without Claude Code?**
Yes. The `clip` CLI and `clip ui` browser app are first-class surfaces, and `clip mcp` lets Claude Desktop (or any MCP client) drive it. Claude Code is one of several entry points — the editor is agnostic to which agent (or human) drives it.

**Does it require an API key?**
No — nowhere. The CLI, the browser UI, the Claude Code skill, and the MCP server all run with no API key. Agent-driven editing uses whichever Claude you already run (Claude Code, or Claude Desktop via MCP); the editor itself never calls a language model.

### Capabilities & limits

**Is it production-ready?**
This release is feature-complete for local editing — a dark timeline editor (view, edit, preview, export), silence removal, transcript editing, captions, export to Final Cut Pro, DaVinci Resolve and Premiere Pro, 19 single-file tools, an MCP server, and 741 tests passing. The API surface is still pre-1.0 (tool schemas may change in minor ways before 1.0). Use it for real work; pin a version in CI.

**What's the maximum video size or duration?**
No hardcoded limit. FFmpeg streams the file rather than loading it into memory, and the browser UI streams uploads to disk — multi-GB recordings work fine. This release isn't tuned for projects with hundreds of clips or runtime above 30 minutes; for those, drive the CLI directly.

**Does it support 4K, HDR, or vertical (TikTok / Reels) formats?**
4K and vertical aspect ratios work out of the box — `render` takes a `maxWidth` and preserves the source aspect ratio. HDR pass-through works; deliberate HDR-to-SDR tone-mapping isn't a named tool yet.

### Privacy & data

**Does it send my video files anywhere?**
No. The editor makes zero network calls — period. The agent runs in Claude Code or Claude Desktop, not inside the editor, so nothing leaves your machine.

**Where does it store my files?**
In a local workspace folder — `$TMPDIR/makemyclip-editor` by default; override with `MAKEMYCLIP_WORKSPACE`. The folder holds input files, output files, `composition.json` (the timeline), `session.json` (the op log), and `snapshots/`. You can version-control the whole folder.

### Working with agents

**Which AI model does it use?**
No language model — the agent is whatever you already run: Claude Code, or Claude Desktop / Cursor via the MCP server. They call the editor's tools; the editor executes them deterministically with FFmpeg. Transcription, if you set it up, runs your local whisper.cpp with a model file you download.

**How does the agent know which tool to call?**
Each tool and timeline verb ships with a Zod input schema (parameter docs inline via `.describe()`) and a one-line description. The Claude Code skill and the MCP server expose that catalog to the agent; it reads the descriptions, picks a tool, and fills in the arguments.

**What if the agent makes a mistake?**
Every edit appends to `session.json` and produces a new output file in the workspace; nothing is destructive. Press `⌘Z` to pop the last op; click Snapshot before risky operations to save a named restore point; the entire workspace is a folder you can `git init`.

### License & comparisons

**Is it free?**
Yes — MIT-licensed, free forever for local editing. No paid tier, no signup, no upsell in the editor. Paid AI-generation features (voice synthesis, music, stock footage) will live on [MakeMyClip.com](https://makemyclip.com) when they ship, behind a separate `@makemyclip/generation` package.

**What's the license situation with the bundled FFmpeg?**
The MakeMyClip Editor source code is [MIT](./LICENSE). The bundled FFmpeg binary (via `ffmpeg-static`) is GPL-licensed because it includes codecs like libx264 and libx265. Subprocess invocation keeps GPL terms confined to the binary, not your application code. For LGPL-only or custom-build requirements (e.g. iOS App Store), set `MAKEMYCLIP_FFMPEG_PATH` to your own binary.

**How is this different from running FFmpeg directly?**
FFmpeg is one binary with a complex CLI; MakeMyClip Editor is 19 named tools with typed inputs, a session log, snapshot/undo, a browser UI, and an agent-callable API. You're still running FFmpeg under the hood — but with a catalog any LLM can call, input validation that prevents bad commands, and a log you can inspect or version-control.

**What's the relationship between this editor and the MakeMyClip.com website?**
The editor (this repo) is MIT-licensed, free, local, and limited to deterministic FFmpeg operations. [MakeMyClip.com](https://makemyclip.com) is the separate hosted product where paid AI generation features will live. The two share the timeline schema, so projects move between them.

**How do I add my own editing tool?**
Add a file in `src/tools/<name>.ts` exporting a Zod input schema and a handler, register it in [`src/ui/tool-registry.ts`](src/ui/tool-registry.ts), and the tool becomes available in the CLI and the browser UI's tool picker. See [AGENTS.md](./AGENTS.md) for conventions.

</details>

---

## Questions people ask

Answers describe v0.4.0 (November 2026).

### How do I edit a video with Claude Code?

Install the MakeMyClip Editor skill with `npx skills add MakeMyClip/editor`, then ask Claude Code in plain words, for example "cut the pauses out of talk.mp4 and add captions." The skill runs the `clip` CLI through `npx`, edits a timeline document in a local workspace folder, and renders with FFmpeg on your machine. Every edit can be undone.

### Is there an iMovie or CapCut for Claude?

MakeMyClip Editor is built for that job: an open-source video editor that Claude drives through a Claude Code skill or an MCP server, with a browser timeline (`clip ui`) where you can watch and take over. It covers everyday edits (trim, join, transitions, titles, captions, silence removal) but isn't a full desktop editor; for finishing, it exports to Final Cut Pro, DaVinci Resolve or Premiere Pro.

### Is there an MCP server for video editing?

Yes. `npx -y @makemyclip/editor mcp` starts MakeMyClip Editor's local MCP server over stdio for Claude Desktop, Cursor, or any MCP client. Its tools show the timeline, edit it (add media, trim, split, remove silence, cut words, remove retakes, caption speech, transitions), check the cuts, transcribe, undo, redo, and export to mp4, FCPXML or Premiere XML. Media stays in one workspace folder, and no API key is needed.

### How do I remove silence from a video automatically?

With MakeMyClip Editor, add the recording to a timeline and run `clip timeline silence <clipId>`, or ask Claude to "cut the pauses." It finds the quiet stretches with FFmpeg, keeps the speech as back-to-back clips, and lands as one undoable edit. `--sensitivity` (0–1) sets how much it cuts, and `--dry-run` lists what it would remove before changing anything.

### Can I edit a video by its transcript offline?

Yes. MakeMyClip Editor transcribes with whisper.cpp on your machine; install it and point `MAKEMYCLIP_WHISPER_MODEL` at a model file. `clip timeline transcribe` returns each word with its time, `cut-words` removes a range of words, and `remove-retakes` cuts the earlier take of each phrase said twice. Nothing is uploaded. Whisper tends to leave out filler words like "um," so the transcript doesn't find them.

### Can Claude add captions or subtitles to a video?

Yes. After transcription, MakeMyClip Editor's `clip timeline captions` (or the UI's Captions button) puts captions timed to the words on a track above the video, and export burns them in. Captions come as short phrases or one word at a time, with your choice of size, color, position, and background. Non-Latin scripts use an installed font that has the glyphs. In the Premiere export, captions become `.srt` files. On Linux, the bundled FFmpeg can't draw text, so set `MAKEMYCLIP_FFMPEG_PATH` to an FFmpeg built with libfreetype and libharfbuzz.

### Can I finish an AI edit in DaVinci Resolve, Premiere Pro or Final Cut Pro?

Yes. MakeMyClip Editor's `clip timeline export cut.fcpxml` writes FCPXML 1.10 for Final Cut Pro and DaVinci Resolve, and `clip timeline export cut.xml` writes Final Cut Pro 7 XML for Premiere Pro. Both keep the cuts, gaps, fades, volume, and cross dissolves, and point at your original files by path. Anything the format can't hold (speed, color adjustments, chroma key) is refused with the fix to make.

### How does MakeMyClip Editor compare to Descript?

Descript is a hosted, closed-source editor with its own AI agent, transcript editing, and paid plans. MakeMyClip Editor is MIT-licensed and local: your agent (Claude Code, Claude Desktop, or another MCP client) edits a timeline file on your machine with FFmpeg and whisper.cpp, and the cut exports to Final Cut Pro, Resolve, or Premiere. Descript offers a richer editing app, collaboration, and AI voice features.

### How does MakeMyClip Editor compare to auto-editor?

auto-editor is a mature open-source command-line tool that cuts silence or motion, edits by word with local transcription, and exports to Premiere, Resolve, and Final Cut Pro. MakeMyClip Editor covers the same talking-head cleanup but keeps the edit as a timeline document that an agent (via the skill or MCP) and a person (in the browser UI) share, with undo for every step and a check that flags cuts that may clip a word.

---

## When to use it

✅ **Great fit** for: cleaning up talking-head videos, tutorials, and podcasts (silence, retakes, captions) before finishing in Final Cut Pro, Resolve, or Premiere · assembling product demos, screen recordings, and social clips with an AI agent doing the labor · scripting repeatable video pipelines in CI · sharing version-controllable timeline JSON · editing offline.

❌ **Not the right tool** for: frame-accurate color grading (use DaVinci Resolve) · multi-track audio mixing with effects (use Reaper, Logic) · generative-AI video (use Runway, Pika) · long-form projects with hundreds of clips.

## Roadmap

- **Now (v0.4.0)** — silence removal, local transcription, edit by transcript, retake removal, captions, export to Final Cut Pro / DaVinci Resolve / Premiere Pro, on top of the dark timeline editor (view / edit / preview / export), 19 tools, MCP server, and snapshot/undo
- **Next** — model picker, SSE for live session updates, AI Elements / shadcn migration
- **1.0** — frozen tool schemas, MCP transport, published Anthropic skill, docs site
- **Beyond** — desktop app (Electron), cloud rendering via [MakeMyClip.com](https://makemyclip.com)

The full milestone log lives in PR descriptions on [GitHub](https://github.com/MakeMyClip/editor/pulls?q=is%3Apr+label%3Aui).

## Acknowledgments

Built on the work of [FFmpeg](https://ffmpeg.org/), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), the [Model Context Protocol](https://modelcontextprotocol.io/), [Anthropic Claude](https://www.anthropic.com/), [Zod](https://zod.dev/), [Hono](https://hono.dev/), [Vite](https://vite.dev/), and [React](https://react.dev/).

## Links

| | |
|---|---|
| **npm** | [`@makemyclip/editor`](https://www.npmjs.com/package/@makemyclip/editor) |
| **Skill page** | [skills.sh/makemyclip/editor/editor](https://skills.sh/makemyclip/editor/editor) |
| **GitHub** | [MakeMyClip/editor](https://github.com/MakeMyClip/editor) |
| **Website** | [makemyclip.com](https://makemyclip.com) |
| **For AI agents** | [llms.txt](./llms.txt) |
| **Issues** | [GitHub Issues](https://github.com/MakeMyClip/editor/issues) |

## License

[MIT](./LICENSE) for the editor source; GPL for the bundled FFmpeg binary (subprocess-isolated). Use it, fork it, ship it.
