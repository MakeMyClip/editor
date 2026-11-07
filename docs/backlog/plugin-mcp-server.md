# MCP server inside the Claude Code plugin

The `makemyclip-editor` plugin ships only the skill, which drives the `clip` CLI. Declaring the MCP server in `plugin.json` (`mcpServers`) would give Claude Code the timeline tools with image results (frames, cut contact sheets) as well. The plugin directory blocks an unpinned `npx` server, so this needs `npx -y @makemyclip/editor@<version> mcp` kept in step with each release: the release job would have to commit the bump back (for example `@semantic-release/git`), which it doesn't do today.
