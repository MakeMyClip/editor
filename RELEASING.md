# Releasing

This repo uses **[semantic-release](https://semantic-release.gitbook.io/)** with **npm Trusted Publishing (OIDC)** and **provenance attestation**. Every merge to `main` runs the release workflow, which decides whether to publish based on the commit messages since the last release.

## Day-to-day

You don't run any release commands. Just merge PRs with conventional commit messages:

| Commit type | Effect |
|---|---|
| `feat: …` | Minor release (e.g. 0.1.0 → 0.2.0) |
| `fix: …` | Patch release (e.g. 0.1.0 → 0.1.1) |
| `feat!: …` or any commit with `BREAKING CHANGE:` in the body | Major release (e.g. 0.1.0 → 1.0.0) |
| `chore(deps): …` or `chore(security): …` | Patch release |
| Any other `chore: …`, `docs: …`, `style: …`, `test: …`, `refactor: …` | No release |

When the workflow publishes, it:

1. Reads commits since the last tag, decides the next version
2. Updates `CHANGELOG.md` for the release notes
3. Publishes to npm at `@makemyclip/editor` with provenance attestation
4. Creates a GitHub Release with auto-generated notes, with the Claude Desktop extension `makemyclip-editor.mcpb` attached (built by `pnpm build:mcpb`)
5. Tags the commit as `v<version>`
6. Lists the version in the official MCP Registry as `io.github.MakeMyClip/editor` (`pnpm registry:publish`, after npm has it and the `.mcpb` is on the release)

The package shows a verified publisher badge on npmjs.com because of provenance.

### MCP Registry

`server.json` holds the listing. At release, `pnpm registry:prepare` stamps it with the version and adds the `.mcpb` (its release URL and SHA-256); that change stays in the release job's checkout. The registry checks that the npm version's `package.json` has `"mcpName": "io.github.MakeMyClip/editor"`, case included, and that the `.mcpb` URL is reachable. The release job logs in with GitHub OIDC (`mcp-publisher login github-oidc`), which grants the `io.github.MakeMyClip/*` namespace; `mcp-publisher` is downloaded and checked against its sigstore signature.

If the registry step fails, npm and the GitHub release are already out, and re-running the job does nothing (semantic-release sees no new commits). List the version by hand from a checkout of the tag: `pnpm build && pnpm build:mcpb`, replace `release/makemyclip-editor.mcpb` with the asset from the GitHub release (the registry entry must match its SHA-256), `pnpm registry:prepare`, then `mcp-publisher login github --token <PAT>` (a token with `read:org`, from an owner of the MakeMyClip organization; the interactive login can't publish to an organization namespace) and `mcp-publisher publish`.

## First-time setup

These steps run **once**, before the first automatic release.

### 1. Configure OIDC trusted publishing on npm

1. Sign in at [npmjs.com](https://www.npmjs.com).
2. Open the package settings for `@makemyclip/editor` → **Trusted Publishers**.
3. Add a publisher with:
   - Publisher: **GitHub Actions**
   - Organization: `MakeMyClip`
   - Repository: `editor`
   - Workflow file: `release.yml`
   - Environment: (leave blank)

This authorizes the `release.yml` workflow to exchange its GitHub OIDC token for a short-lived npm publish token. **No `NPM_TOKEN` repo secret is needed.**

### 2. Tag the bootstrap commit

semantic-release needs a baseline tag to decide the next version. Tag `main` with `v0.0.0` so the first real release becomes `v0.0.1` (for `fix:`) or `v0.1.0` (for `feat:`) instead of jumping to `v1.0.0`.

```bash
git checkout main && git pull
git tag v0.0.0
git push --tags
```

### 3. Land a `feat:` or `fix:` commit

The next PR merged to `main` whose commit subject begins with `feat:` or `fix:` triggers the first release. semantic-release reads the commit, computes the version, and publishes.

## Manual override

For emergencies (semantic-release outage, urgent hotfix outside the conventional-commits flow), you can still publish by hand:

```bash
git checkout main && git pull
npm version <patch|minor|major>
npm publish --access public
git push --follow-tags
```

This bypasses the changelog and GitHub Release steps. Use only when automation is broken.

## Branches

| Branch | npm dist-tag | Behavior |
|---|---|---|
| `main` | `latest` | Stable releases |

To add an alpha prerelease channel later, append `{ "name": "next", "prerelease": "alpha", "channel": "alpha" }` to the `branches` array in `.releaserc.json`. Commits merged to `next` will publish under the `alpha` dist-tag.
