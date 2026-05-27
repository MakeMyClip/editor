// Mirrors the shape returned by /api/session — kept in sync manually with
// src/session/types.ts because the React build isn't aware of the parent
// editor package's types.

export interface SessionEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  timestamp: string;
}

export interface Session {
  version: 1;
  entries: SessionEntry[];
}
