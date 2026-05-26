# AGENTS.md

Development guide for AI agents and human contributors working on **MakeMyClip Editor** — an MCP server + agent skill that wraps FFmpeg for AI-driven video editing.

For contribution policy, commit format, and PR process, see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Project shape

```
editor/
├── src/
│   ├── mcp/          # MCP server entry, tool registration
│   ├── tools/        # one file per tool (trim, zoom_pan, add_text, …)
│   ├── timeline/     # Zod schema + helpers for the timeline JSON
│   ├── ffmpeg/       # safe FFmpeg arg builders + subprocess runner
│   ├── preview/      # HTML preview generator
│   └── cli.ts        # `clip` CLI entry
├── tests/
├── examples/
├── SKILL.md
├── AGENTS.md
├── CONTRIBUTING.md
├── CLAUDE.md
└── package.json
```

## Stack

- **Language:** TypeScript (Node 20+)
- **Package manager:** npm (single registry, no pnpm/yarn lockfile drift)
- **MCP:** `@modelcontextprotocol/sdk`
- **Validation:** `zod` (timeline schema is shared with MakeMyClip.com)
- **Subprocess:** `execa` — args always as an array, never shell-string
- **FFmpeg:** `@ffmpeg-installer/ffmpeg` (bundled) with fallback to system binary
- **Image ops:** `sharp` (frame thumbnails, simple CV)
- **Tests:** `vitest`
- **Lint/format:** `eslint` + `prettier`

## Non-negotiables

1. **No shell interpolation.** All `execa`/`spawn` calls take args as `string[]`. No `shell: true`. No `exec(...)` with concatenated strings.
2. **Timeline JSON is the source of truth.** Tools build/mutate a timeline; rendering reads it. Never render straight from tool args.
3. **Workspace sandbox.** File paths from MCP tools are resolved against a workspace directory. No reads/writes outside it without explicit user consent.
4. **No network calls in the OSS core.** Generation tools (voiceover, music, b-roll) live behind a separate `@makemyclip/generation` package and require explicit user opt-in.
5. **MIT compatible deps only.** Don't pull in GPL/AGPL/BSL packages.

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

## MCP tools

Each tool lives in `src/tools/<name>.ts` and exports:

```ts
export const trim = {
  name: 'trim',
  description: 'Cut a clip between start and end timecodes.',
  inputSchema: z.object({ input: z.string(), start: z.string(), end: z.string() }),
  handler: async (args) => { /* … */ },
};
```

Rules:
- One tool per file.
- `description` is the agent-facing docs — write it for an LLM reader.
- Handlers return `{ path, timeline }` — never raw FFmpeg output.
- Handlers must be idempotent given the same input + workspace state.

## FFmpeg

- All commands go through `src/ffmpeg/run.ts`.
- Arg builders live in `src/ffmpeg/args/` — one per primitive (filter chain, scale, drawtext, …).
- Never embed user-provided strings into a filter graph without escaping via the helper in `src/ffmpeg/escape.ts`.

## Testing

- `npm test` runs vitest.
- `npm run type-check` runs `tsc --noEmit`.
- `npm run lint` runs eslint.
- Run all three before committing.
- For tool handlers: write a unit test that asserts the built FFmpeg arg array, not the rendered output (deterministic, fast, no FFmpeg needed in CI).
- Integration tests against real FFmpeg live in `tests/integration/` and run on CI only.

## Branch & commit rules

See [CONTRIBUTING.md](./CONTRIBUTING.md). Summary:

- Branch: `<type>/<short-kebab-description>` — e.g. `feat/zoom-pan-tool`. **No `claude/*` or other agent-prefixed branches.**
- Commit: Conventional Commits — `<type>(<scope>): <description>`.
- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`.
- Scopes for this project: `mcp`, `tools`, `timeline`, `ffmpeg`, `cli`, `preview`, `schema`, `deps`, `docs`, `ci`.
