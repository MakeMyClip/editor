#!/usr/bin/env node
import { startStdioServer } from './mcp/server.js';
import { trim } from './tools/trim.js';

const HELP = `clip — MakeMyClip Editor

Usage:
  clip serve                          Start the MCP server on stdio (default for AI agents)
  clip trim <input> <start> <end>     Trim a clip between two timecodes
  clip --help                         Show this help

Examples:
  clip trim screen.mp4 00:00:05 00:00:42
  clip serve                          # registered with Claude/Cursor as an MCP server
`;

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;

  if (!command || command === 'serve') {
    await startStdioServer();
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (command === 'trim') {
    const [input, start, end] = args;
    if (!input || !start || !end) {
      process.stderr.write('Usage: clip trim <input> <start> <end>\n');
      process.exit(1);
    }
    const result = await trim({ input, start, end });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
