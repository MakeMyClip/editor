# Roadmap

## v1 target: ~20 tools, ~85% of common iMovie workflows

Wide enough to cover the editing *intents* users actually ask for; narrow enough that the agent can pick the right tool without confusion. Past ~15 well-named tools, agent selection accuracy drops sharply — so the goal is "complete coverage of common iMovie use cases" via primitives + a handful of composites, not 1-to-1 menu-item parity.

### Out of v1, by design

- **MCP server** — returns when the state engine + resources actually justify the surface (currently dropped; preserved in git history)
- **Visual UI** — phase 2 of the broader product roadmap (iMovie/CapCut-style desktop app)
- **Cloud rendering / remote processor** — phase 3 (makemyclip.com)
- **Anything needing ML/heuristics beyond FFmpeg** — Magic Movie, scene-importance auto-edit
- **OS integration** — Photo Library browser, in-app voiceover recording

## Tool surface

### Phase 1 — editing primitives + workflow plumbing (~2 weeks)

| Tool | Purpose | FFmpeg path | Risk |
|---|---|---|---|
| `ingest` | Probe + register media in timeline; gives every other tool a mediaId to work with | ffprobe | low |
| `trim` ✅ | Cut between two timecodes | `-ss`/`-to` (stream-copy) | shipped |
| `split` | Split clip at timecode (two outputs) | same as trim | low |
| `concat` | Stitch clips back-to-back | concat demuxer | low |
| `add_text` | Captions, titles, lower-thirds | `drawtext` filter | **high** (escaping footgun — council's #2 risk) |
| `add_audio` | Music / voiceover / sfx with fade + duck | `amix`, `afade`, `sidechaincompress` | medium |
| `transition` | Crossfade, dip-to-black, cut, wipe | `xfade` filter | medium |
| `render` | Export to final mp4/mov/webm with codec/quality control | full encode pass | low |
| `preview` | Frame thumbnail / range GIF / waveform for agent self-correction | `-vframes`, palette | low (but high value) |

Also lands in this phase: the **state engine** — `applyOp(timeline, op) → timeline`. Without it, multi-tool composition is impossible. The schema in [src/timeline/schema.ts](../src/timeline/schema.ts) is currently a placeholder; the engine makes it real.

### Phase 2 — visual primitives (~2 weeks)

| Tool | Purpose | Notes |
|---|---|---|
| `transform` | crop / rotate / scale / flip | trivial filters |
| `adjust` | Color, brightness, contrast, saturation, volume — one tool with optional params | matches iMovie's adjustment panel |
| `zoom_pan` | Ken Burns / focus zoom on a region | `zoompan` filter |
| `speed` | Slow-mo, fast-forward, reverse | `setpts` + `atempo` (tricky to keep sync) |
| `overlay` | Picture-in-picture, image overlay | `overlay` filter |

### Phase 3 — safety + composites (~1-2 weeks)

| Tool | Purpose |
|---|---|
| `snapshot` + `undo` | Save/restore timeline state (council's must-have for recovery loops) |
| `inspect` | Get current timeline summary (agent's "where am I") |
| `delete` / `move` | Timeline composition ops once the state engine is real |
| `add_title_card` | Composite: color source + drawtext + transition into first clip |
| `add_captions` | Composite: transcribe (Whisper.cpp dep) + `add_text` per cue |
| `silence_remove` | Wraps `auto-editor` (existing OSS, MIT, active) |
| `highlight_reel` | Composite chaining trim + concat + add_text + transition with smart defaults |

### Phase 4 — specialty (opportunistic, demand-driven)

| Tool | Notes |
|---|---|
| `chroma_key` | Easy filter; demand to be confirmed |
| `stabilize` | Needs `vidstab`-enabled FFmpeg build — capability-detect at runtime, fail cleanly otherwise |

## Build order rationale

1. **`ingest` first.** Every other tool benefits from probe data + a mediaId registry. Today `trim` takes a path; in the new world tools take mediaIds and the agent ingests once.
2. **`preview` early.** Unblocks the agent's self-correction loop. Without it the agent flies blind on a medium it can't see.
3. **`add_text` early.** Exercises the FFmpeg escaping path (council's #2 risk: drawtext colon/quote/comma escaping). Lock the escape harness before more filter-graph tools land.
4. **State engine before composites.** `add_title_card`, `highlight_reel`, etc. need `applyOp`. Don't ship them until the engine can compose.
5. **`render` can wait.** `trim` already produces files. `render` becomes meaningful only once a multi-clip timeline exists.

## Effort estimate

| Phase | Scope | Estimate |
|---|---|---|
| 1 | 8 tools + state engine | ~2 weeks |
| 2 | 5 visual primitives | ~2 weeks |
| 3 | 4 safety + 4 composites | ~1–2 weeks |
| 4 | 1–2 specialty tools | opportunistic |
| **v1 total** | **~85% iMovie coverage** | **~6–8 weeks of focused work** |

## What v1 explicitly is NOT

- A drop-in iMovie replacement for visual editors (no UI — that's phase 2)
- A magical Hollywood editor (no Magic Movie / theme intelligence beyond the agent's reasoning)
- A multi-camera editor (single video + audio track in v1)
- A color-grading suite (basic adjustments only)
- A motion-graphics tool

These belong in phases 2 (desktop UI) and 3 (cloud) of the broader product roadmap, or stay out of scope entirely.

## Living document

This roadmap is a snapshot of intent, not a contract. Reorder, split, drop, or add tools as user requests surface what's actually wanted vs what was assumed. Every change to scope should leave a note here (or in a `CHANGELOG.md` once one exists).
