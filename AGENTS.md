# AGENTS.md

Development guide for AI agents and human contributors working on **MakeMyClip Editor** — a Claude Code skill, `clip` CLI, MCP server and local browser UI that wrap FFmpeg for AI-driven video editing.

For contribution policy, commit format, and PR process, see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Project shape

```
editor/
├── src/
│   ├── tools/        # one file per tool (trim, zoom_pan, add_text, …)
│   ├── timeline/     # composition document: schema, ops/verbs, store, export compiler
│   ├── ffmpeg/       # safe FFmpeg arg builders + subprocess runner
│   ├── mcp/          # `clip mcp` server: timeline tools over stdio for MCP clients
│   ├── ui/           # `clip ui` browser editor: Hono server + Vite web app
│   ├── session/      # session.json op log of tool invocations (audit + undo)
│   ├── storage/      # revisioned JSON store with serialized, CAS-checked writes
│   ├── workspace.ts  # workspace root + path confinement (non-negotiable #3)
│   ├── cli.ts        # `clip` CLI entry
│   ├── cli-timeline.ts  # `clip timeline …` subcommands
│   └── index.ts      # library exports (package `main`)
├── tests/
├── SKILL.md          # Claude Code skill: triggers + shell-out instructions
├── AGENTS.md
├── CONTRIBUTING.md
├── CLAUDE.md
└── package.json
```

The MCP server (`src/mcp/server.ts`, started with `clip mcp`) exposes the timeline tools over stdio to Claude Desktop and other MCP clients, alongside the skill + CLI path.

## Stack

- **Language:** TypeScript (Node 24+)
- **Package manager:** pnpm (fast installs, strict resolution, content-addressable store; version pinned via `packageManager` field in `package.json`)
- **Validation:** `zod` (timeline schema is shared with MakeMyClip.com)
- **Subprocess:** `execa` — args always as an array, never shell-string
- **FFmpeg:** `ffmpeg-static` (bundled); `$MAKEMYCLIP_FFMPEG_PATH` overrides it, and the system `ffmpeg` is the last fallback
- **MCP:** `@modelcontextprotocol/sdk` (stdio server)
- **UI:** `hono` + `@hono/node-server` (local API server), React 19 + Vite (web app in `src/ui/web/`)
- **Build:** `tsup` (CLI + library bundle and `.d.ts`), `vite build` (UI)
- **Tests:** `vitest`
- **Lint/format:** `@biomejs/biome` (single Rust binary, replaces eslint + prettier)

## Non-negotiables

1. **No shell interpolation.** All `execa`/`spawn` calls take args as `string[]`. No `shell: true`. No `exec(...)` with concatenated strings.
2. **The timeline document is the source of truth.** Assembled edits mutate the composition (`src/timeline/`, `clip timeline …`), and export compiles it to FFmpeg. The single-file tools (`clip trim`, `clip zoom_pan`, …) still render straight from their args; new assembly features go through the composition.
3. **Workspace sandbox.** Paths from `clip ui` and MCP callers are confined to the workspace (`resolveInWorkspace` in `src/workspace.ts`; `$MAKEMYCLIP_WORKSPACE`, default `$TMPDIR/makemyclip-editor`). CLI paths resolve against the current directory. No reads/writes outside the workspace without explicit user consent.
4. **No network calls in the OSS core.** Generation tools (voiceover, music, b-roll) will live behind a separate `@makemyclip/generation` package (not built yet) and require explicit user opt-in.
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
- Files: `kebab-case.ts` (e.g. `zoom-pan.ts`); in the React app, components are `PascalCase.tsx` (`Timeline.tsx`) and hooks `useCamelCase.ts` (`useTimeline.ts`)
- Functions/variables: `camelCase`
- Types/interfaces: `PascalCase`
- Boolean variables: `is*`, `has*`, `should*`
- Named exports only — no default exports, except in tool config files that require one (`vite.config.ts`, `tsup.config.ts`, `vitest.config.ts`)

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
- A **handler function** (`foo(input) -> Promise<FooResult>`) — does the work, returns a typed result
- The CLI wires tools into subcommands in `src/cli.ts` (`clip timeline …` in `src/cli-timeline.ts`); the UI exposes them through `src/ui/tool-registry.ts`
- The skill (`SKILL.md`) instructs Claude Code to invoke them via `npx -y @makemyclip/editor <tool>`

Rules:
- One tool per file.
- Zod schema is the single source of input truth.
- Handlers return a typed result — `{ path, ... }` for tools that write a file (`ingest.ts`, `inspect.ts`, `split.ts`, `undo.ts` and `delete-op.ts` return other shapes) — never raw FFmpeg output.
- Handlers must be idempotent given the same input + workspace state.

## FFmpeg

- All FFmpeg runs go through `runFfmpeg` in `src/ffmpeg/run.ts`. The one exception is `src/ffmpeg/probe.ts`, which calls `execa` with `reject: false` so it can parse stderr from a failed probe.
- Arg builders live in `src/ffmpeg/args/` — mostly one per tool (`trim.ts`, `add-text.ts`, …); a few composite tools build their args inline. The timeline export compiler (`src/timeline/compile.ts`) builds its own filter graphs.
- Never embed user-provided strings into a filter graph without escaping via the helper in `src/ffmpeg/escape.ts`.

## Testing

- `pnpm test` runs vitest.
- `pnpm type-check` runs `tsc --noEmit` for the core and again for `src/ui/web/tsconfig.json`.
- `pnpm lint` runs `biome check`.
- Run all three before committing. CI also runs `pnpm build` (tsup + the Vite UI build).
- For tool handlers: write a unit test that asserts the built FFmpeg arg array, not the rendered output (deterministic, fast, no FFmpeg needed in CI).

## Branch & commit rules

See [CONTRIBUTING.md](./CONTRIBUTING.md). Summary:

- Branch: `<type>/<short-kebab-description>` — e.g. `feat/zoom-pan-tool`. **No `claude/*` or other agent-prefixed branches.**
- Commit: Conventional Commits — `<type>(<scope>): <description>`.
- Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`.
- Scopes for this project: `tools`, `timeline`, `ffmpeg`, `cli`, `mcp`, `ui`, `schema`, `skill`, `deps`, `docs`, `ci`.
