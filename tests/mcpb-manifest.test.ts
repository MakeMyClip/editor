import { readFileSync } from 'node:fs';
import { getMcpConfigForManifest, v0_3 } from '@anthropic-ai/mcpb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FFMPEG_PATH_ENV } from '../src/ffmpeg/run.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { WHISPER_MODEL_ENV, WHISPER_PATH_ENV } from '../src/transcribe/whisper.js';

const manifest = JSON.parse(
  readFileSync(new URL('../mcpb/manifest.json', import.meta.url), 'utf8'),
) as v0_3.McpbManifest;

const systemDirs = {
  HOME: '/Users/me',
  DESKTOP: '/Users/me/Desktop',
  DOCUMENTS: '/Users/me/Documents',
  DOWNLOADS: '/Users/me/Downloads',
};

/** The command and env Claude Desktop starts the server with, per the reference implementation. */
async function launchConfig(userConfig: Record<string, string>) {
  const config = await getMcpConfigForManifest({
    manifest,
    extensionPath: '/ext',
    systemDirs,
    userConfig,
    pathSeparator: '/',
  });
  if (!config) throw new Error('no MCP config');
  return config;
}

describe('Claude Desktop extension manifest', () => {
  it('passes the mcpb 0.3 schema', () => {
    expect(v0_3.McpbManifestSchema.safeParse(manifest).error).toBeUndefined();
  });

  it("lists exactly the MCP server's tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();

    expect((manifest.tools ?? []).map((t) => t.name).sort()).toEqual(
      tools.map((t) => t.name).sort(),
    );
  });

  it('starts `clip mcp` with blank optional settings as empty env vars', async () => {
    const config = await launchConfig({});

    expect(config.command).toBe('node');
    expect(config.args).toEqual(['/ext/dist/cli.js', 'mcp']);
    expect(config.env).toEqual({
      MAKEMYCLIP_BUNDLE: 'mcpb',
      MAKEMYCLIP_WORKSPACE: '',
      [FFMPEG_PATH_ENV]: '',
      [WHISPER_MODEL_ENV]: '',
      [WHISPER_PATH_ENV]: '',
    });
  });

  it('passes the settings the user picked', async () => {
    const config = await launchConfig({
      workspace: '/Users/me/Movies',
      ffmpeg_path: '/opt/ffmpeg/bin/ffmpeg',
      whisper_model: '/models/ggml-base.en.bin',
    });

    expect(config.env).toMatchObject({
      MAKEMYCLIP_WORKSPACE: '/Users/me/Movies',
      [FFMPEG_PATH_ENV]: '/opt/ffmpeg/bin/ffmpeg',
      [WHISPER_MODEL_ENV]: '/models/ggml-base.en.bin',
    });
  });
});
