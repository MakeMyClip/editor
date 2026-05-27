# AGENTS.md

Development guide for AI agents and human contributors working on **MakeMyClip Editor** — a Claude Code skill + `clip` CLI that wraps FFmpeg for AI-driven video editing.

For contribution policy, commit format, and PR process, see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Project shape

```
editor/
├── src/
│   ├── tools/        # one file per tool (trim, zoom_pan, add_text, …)
│   ├── timeline/     # Zod schema + helpers for the timeline JSON
│   ├── ffmpeg/       # safe FFmpeg arg builders + subprocess runner
│   ├── preview/      # HTML preview generator
│   └── cli.ts        # `clip` CLI entry — the single execution surface
├── tests/
├── examples/
├── SKILL.md          # Claude Code skill: triggers + shell-out instructions
├── AGENTS.md
├── CONTRIBUTING.md
├── CLAUDE.md
└── package.json
```

MCP server is intentionally out of scope for the current polish phase — the skill+CLI path covers the primary audience (Claude Code) with one-command setup. MCP will return when the state engine and resources actually justify the surface.

## Stack

- **Language:** TypeScript (Node 24+)
- **Package manager:** pnpm (fast installs, strict resolution, content-addressable store; version pinned via `packageManager` field in `package.json`)
- **Validation:** `zod` (timeline schema is shared with MakeMyClip.com)
- **Subprocess:** `execa` — args always as an array, never shell-string
- **FFmpeg:** `ffmpeg-static` (bundled) with fallback to `$MAKEMYCLIP_FFMPEG_PATH` or system binary
- **Image ops:** `sharp` (frame thumbnails, simple CV)
- **Tests:** `vitest`
- **Lint/format:** `@biomejs/biome` (single Rust binary, replaces eslint + prettier)

## Non-negotiables

1. **No shell interpolation.** All `execa`/`spawn` calls take args as `string[]`. No `shell: true`. No `exec(...)` with concatenated strings.
2. **Timeline JSON is the source of truth.** Tools build/mutate a timeline; rendering reads it. Never render straight from tool args.
3. **Workspace sandbox.** File paths from MCP tools are resolved against a workspace directory. No reads/writes outside it without explicit user consent.
4. **No network calls in the OSS core.** Generation tools (voiceover, music, b-roll) live behind a separate `@makemyclip/generation` package and require explicit user opt-in.
5. **MIT-compatible npm dependencies only.** Don't pull in GPL/AGPL/BSL packages into the TypeScript dependency graph. The bundled FFmpeg binary is separately licensed (GPL) — that's fine because we invoke it as a subprocess, not link to it. See the README's License section for the full posture.

## Code style

### TypeScript

- Prefer `interface` over `type` for object shapes; `type` for unions/intersections.
- Use Zod for any boundary (MCP tool inputs, file I/O, network).
- No `enum` — use string-literal unions or `as const` maps.
- No classes for stateless logic — use functions and modules.
- Explicit return types on exported functions.

### Naming

- Directories: `kebab-case` (e.g. `src/timeline-helpers/`)
- Files: `kebab-case.ts` (e.g. `zoom-pan.ts`)
- Functions/variables: `camelCase`
- Types/interfaces: `PascalCase`
- Boolean variables: `is*`, `has*`, `should*`
- Named exports only — no default exports

### Comments

- Self-documenting code first; comments explain **why**, not what.
- No "this function does X" docstrings — the signature already does that.
- Add JSDoc only for exported public APIs (MCP tool descriptions, schema docs).
- Never reference tickets, PRs, or "added for X" in comments — those rot.

### Errors

- Throw typed errors with actionable messages — they surface to the agent.
- Validate at boundaries (MCP input, file I/O); trust internal calls.
- No defensive `try/catch` around code that can't fail.

## Tools

Each tool lives in `src/tools/<name>.ts` and exports:

- A **Zod input schema** (`FooInput`) — validates arguments at the boundary
- A **handler function** (`foo(input) -> Promise<FooResult>`) — does the work, returns `{ path, ... }`
- The CLI wires tools into subcommands in `src/cli.ts`
- The skill (`SKILL.md`) instructs Claude Code to invoke them via `npx -y @makemyclip/editor <tool>`

Rules:
- One tool per file.
- Zod schema is the single source of input truth; the CLI parses argv into it.
- Handlers return `{ path, ... }` — never raw FFmpeg output.
- Handlers must be idempotent given the same input + workspace state.

## FFmpeg

- All commands go through `src/ffmpeg/run.ts`.
- Arg builders live in `src/ffmpeg/args/` — one per primitive (filter chain, scale, drawtext, …).
- Never embed user-provided strings into a filter graph without escaping via the helper in `src/ffmpeg/escape.ts`.

## Testing

- `pnpm test` runs vitest.
- `pnpm type-check` runs `tsc --noEmit`.
- `pnpm lint` runs `biome check`.
- Run all three before committing.
- For tool handlers: write a unit test that asserts the built FFmpeg arg array, not the rendered output (deterministic, fast, no FFmpeg needed in CI).
- Integration tests against real FFmpeg live in `tests/integration/` and run on CI only.

## Branch & commit rules

See [CONTRIBUTING.md](./CONTRIBUTING.md). Summary:

- Branch: `<type>/<short-kebab-description>` — e.g. `feat/zoom-pan-tool`. **No `claude/*` or other agent-prefixed branches.**
- Commit: Conventional Commits — `<type>(<scope>): <description>`.
- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`.
- Scopes for this project: `tools`, `timeline`, `ffmpeg`, `cli`, `preview`, `schema`, `skill`, `deps`, `docs`, `ci`.
