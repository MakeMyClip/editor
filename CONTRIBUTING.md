# Contributing to MakeMyClip Editor

Thanks for your interest in contributing! This document covers the workflow, commit format, and code standards for this repo.

For architecture and stack details, see [AGENTS.md](./AGENTS.md).

## Development Workflow

1. Create a feature branch from `main` (see [Branch Naming](#branch-naming) below)
2. Make changes in `src/`
3. Run `pnpm lint`, `pnpm type-check`, and `pnpm test` to ensure quality
4. Test locally with `pnpm dev`
5. Submit a pull request with a clear description

## Branch Naming

Use the standard `<type>/<short-kebab-case-description>` format — **not** `claude/<random-text>` or any other tool-prefixed pattern.

**Format**: `<type>/<short-kebab-case-description>`

**Types** (mirror commit types below): `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`

**Examples**:
- `feat/zoom-pan-tool`
- `fix/ffmpeg-arg-escape`
- `chore/upgrade-mcp-sdk`
- `docs/skill-md-frontmatter`
- `refactor/timeline-schema-split`

**Rules**:
- Lowercase, kebab-case, no random suffixes or session IDs
- Keep it short and descriptive (3–6 words max)
- Do **not** prefix with `claude/`, `cursor/`, or any other agent name — pick the type that matches the work

## Commit Message Format

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

### Format

```
<type>(<scope>): <description>
```

### Commit Types

**Core Types**:
- `feat`: New user-facing functionality
  - Example: `feat(tools): add zoom_pan tool with Ken Burns easing`
  - Example: `feat(mcp): expose timeline preview as resource`

- `fix`: Bug fixes
  - Example: `fix(ffmpeg): escape colons in drawtext filter`
  - Example: `fix(timeline): clamp negative trim ranges`

- `chore`: Maintenance, dependency updates, build changes
  - Example: `chore(deps): bump @modelcontextprotocol/sdk to 0.6.0`

**Additional Types**:
- `docs`: Documentation changes only
- `style`: Formatting, whitespace (no logic change)
- `refactor`: Code restructure without behavior change
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `build`: Build system / external dependencies
- `ci`: CI/CD pipeline changes
- `revert`: Reverting a previous commit

### Scopes

Optional but recommended:
- `tools`: Individual tool handlers (trim, zoom_pan, add_text, …)
- `timeline`: Timeline schema and helpers
- `ffmpeg`: FFmpeg arg builders, escaping, subprocess
- `cli`: `clip` CLI entry
- `preview`: HTML preview generator
- `schema`: Zod schemas shared with MakeMyClip.com
- `skill`: SKILL.md and skill-registry integration
- `deps`: Dependencies and packages
- `docs`: Documentation
- `ci`: GitHub Actions, release pipeline

### Guidelines

- Keep description under 50 characters when possible
- Use imperative mood ("add" not "added")
- Capitalize first letter of description
- No period at the end
- Reference issues with `#123` when applicable
- For breaking changes, add `BREAKING CHANGE:` in the footer
- Be specific: "fix drawtext colon escape" not "fix bug"

### Examples

```
feat(tools): add zoom_pan tool with region focus
fix(ffmpeg): escape special chars in drawtext input
docs(skill): document SKILL.md frontmatter fields
refactor(timeline): split schema into clip and track modules
perf(preview): cache thumbnail generation by hash
chore(deps): update execa to 9.x
test(tools): cover trim edge cases at timeline boundaries
style: align imports and remove trailing whitespace
build: switch to tsup for bundling
ci: add branch-name validation workflow
```

## Code Style

See [AGENTS.md](./AGENTS.md#code-style) for the full style guide. Quick summary:

### TypeScript

- Prefer `interface` over `type` for object shapes
- Use Zod for runtime validation at every boundary
- Avoid `enum`; use string-literal unions or `as const`
- No classes for stateless logic — use functions and modules
- Explicit return types on exported functions

### Naming Conventions

- Directories: `kebab-case` (e.g. `src/timeline-helpers/`)
- Files: `kebab-case.ts`
- Functions/variables: `camelCase`
- Types/interfaces: `PascalCase`
- Boolean variables with auxiliary verbs (`isLoading`, `hasError`)
- Named exports only

### Self-Documenting Code

- Code and identifiers must be self-documenting
- No comments that restate what code does
- Add comments to explain **why** (business logic, workarounds, non-obvious decisions)
- JSDoc only for exported public APIs and MCP tool descriptions

## Project-specific Guidelines

### Safety

- **Never** pass user input to FFmpeg via shell strings. Args are always `string[]`.
- **Never** read/write files outside the workspace sandbox without explicit user consent.
- **No network calls** in the OSS core — generation features live in a separate package.

### MCP tools

- One tool per file under `src/tools/`
- `description` is agent-facing — write it for an LLM reader, not a human
- Handlers return `{ path, timeline }` — never raw FFmpeg output
- Handlers must be idempotent given the same workspace state

### Timeline

- The timeline JSON (Zod-validated) is the source of truth
- Tools mutate the timeline; rendering reads from it
- Schema lives in `src/timeline/schema.ts` and is exported for the web app

## Testing

- Run `pnpm lint` before committing
- Run `pnpm type-check` to ensure types pass
- Run `pnpm test` to execute the unit test suite
- Tool unit tests assert built FFmpeg arg arrays (no FFmpeg needed)
- Integration tests live in `tests/integration/` and run on CI

## Pull Request Process

1. Ensure your branch is up to date with `main`
2. Make sure linting, type-check, and tests pass
3. Confirm your branch name matches `<type>/<kebab-description>`
4. Write a clear PR description:
   - **What** changed
   - **Why** the change was needed
   - **How** to test it
5. Reference related issues with `#123`
6. Request review from a maintainer

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

## Questions?

- Read [AGENTS.md](./AGENTS.md) for architecture and dev guidelines
- Read [SKILL.md](./SKILL.md) for the agent-skill contract
- Open an [issue](https://github.com/MakeMyClip/editor/issues) for discussion

Thanks for contributing to MakeMyClip Editor!
