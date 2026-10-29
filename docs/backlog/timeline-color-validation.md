# Timeline color validation

Timeline `color` / `background` fields are bare `z.string()` (src/timeline/composition.ts, ops.ts) and `quoteColor` in src/timeline/compile.ts passes non-`#` values into the filtergraph unescaped, so a value like `red,drawtext=...` adds a filter; validate them as hex or a named-color allowlist in the schema.
