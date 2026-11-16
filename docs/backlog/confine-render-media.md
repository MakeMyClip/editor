# Re-check media against the workspace on every render for the UI and MCP

`POST /api/timelines/export` re-checks each short's files with `confinedMediaMap`, so a registered file swapped for a symlink out of the workspace is refused. Three older render paths still take the registry as ingested (`buildMediaMap`):

- `POST /api/timeline/export` (mp4) in `src/ui/server.ts`;
- `GET /api/timeline/frame` in `src/ui/server.ts`;
- the mp4 path of MCP `timeline_export` in `src/mcp/server.ts`.

The transcript and project-file paths already confine. Pass `confinedMediaMap(comp)` on these three, and test each with a symlinked file, as `tests/ui-timelines.test.ts` does for export-all. Found by the Codex review of the UI shorts PR (2026-11-15).
