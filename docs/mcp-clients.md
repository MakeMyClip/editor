# MCP Client Setup

MakeMyClip Editor speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio. After installing the package globally, add an MCP server entry to your client's config pointing at `clip serve`.

```bash
npm i -g @makemyclip/editor
```

> **Using Claude Code?** Skip this — install via the [skill registry](../SKILL.md) instead: `npx skills add MakeMyClip/editor`. It's one command, no config to edit, no client restart.

## Claude Desktop

Edit the config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%/Claude/claude_desktop_config.json`

Add:

```json
{
  "mcpServers": {
    "makemyclip-editor": {
      "command": "clip",
      "args": ["serve"]
    }
  }
}
```

Restart Claude Desktop. The `trim` tool will appear in the tool list.

## Cursor

Edit `~/.cursor/mcp.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "makemyclip-editor": {
      "command": "clip",
      "args": ["serve"]
    }
  }
}
```

Restart Cursor.

## Other MCP clients

Continue, Zed, and most other MCP clients use the same `command` / `args` shape. Consult your client's MCP setup docs for the config file location and exact field names; the values above are what to put in.

## No-install variant (via npx)

If you'd rather skip the global install, point `command` at `npx`:

```json
{
  "mcpServers": {
    "makemyclip-editor": {
      "command": "npx",
      "args": ["-y", "@makemyclip/editor", "serve"]
    }
  }
}
```

First call downloads the package (~30s); subsequent calls are fast. Useful for trying it out before committing to a global install.

## Workspace and binary overrides

Two environment variables tune the runtime:

- `MAKEMYCLIP_WORKSPACE` — directory where output files are written. Defaults to `os.tmpdir()/makemyclip-editor`.
- `MAKEMYCLIP_FFMPEG_PATH` — explicit FFmpeg binary path. Bypasses the bundled `ffmpeg-static` binary. Useful if you need an LGPL-only build, an HEVC-capable system binary, or a hardware-accelerated build.

Set them on the server entry's `env` object:

```json
{
  "mcpServers": {
    "makemyclip-editor": {
      "command": "clip",
      "args": ["serve"],
      "env": {
        "MAKEMYCLIP_WORKSPACE": "/Users/you/Movies/makemyclip",
        "MAKEMYCLIP_FFMPEG_PATH": "/opt/homebrew/bin/ffmpeg"
      }
    }
  }
}
```

## Verifying the setup

After restarting your client, ask it to "list the available tools" or watch for the `makemyclip-editor` server to appear in the tools/connection panel (location varies by client). You should see `trim` exposed. Try:

> Trim `~/Desktop/screen-recording.mov` from 0:05 to 0:42.

The agent should call `trim`, FFmpeg should run (a few seconds for a short clip), and you'll get back a path to the trimmed output.
