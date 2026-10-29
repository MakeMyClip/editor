# CLI input validation

`src/cli.ts` never runs a tool's Zod `*Input.parse`, and handlers like `trim` don't either, so CLI arguments reach the FFmpeg arg builders unvalidated; parse argv through each tool's schema in the CLI.
