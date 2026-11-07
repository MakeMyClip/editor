import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FFMPEG_PATH_ENV } from '../src/ffmpeg/run.js';
import { WHISPER_MODEL_ENV, WHISPER_PATH_ENV } from '../src/transcribe/whisper.js';

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;

const pkg = read('../package.json') as { name: string; mcpName: string; homepage: string };
const server = read('../server.json') as {
  name: string;
  description: string;
  repository: { url: string };
  packages: {
    registryType: string;
    identifier: string;
    packageArguments: { value: string }[];
    environmentVariables: { name: string }[];
  }[];
};

describe('MCP Registry server.json', () => {
  it('matches the mcpName the registry checks on npm, case included', () => {
    expect(server.name).toBe('io.github.MakeMyClip/editor');
    expect(pkg.mcpName).toBe(server.name);
  });

  it('fits the registry limits and points at this repo', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.repository.url).toBe(pkg.homepage);
  });

  it('runs `npx @makemyclip/editor mcp` with the env the server reads', () => {
    const [npm, ...rest] = server.packages;
    expect(rest).toEqual([]);
    expect(npm?.registryType).toBe('npm');
    expect(npm?.identifier).toBe(pkg.name);
    expect(npm?.packageArguments.map((a) => a.value)).toEqual(['mcp']);
    expect(npm?.environmentVariables.map((e) => e.name).sort()).toEqual(
      ['MAKEMYCLIP_WORKSPACE', FFMPEG_PATH_ENV, WHISPER_MODEL_ENV, WHISPER_PATH_ENV].sort(),
    );
  });
});
