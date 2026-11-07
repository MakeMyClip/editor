/**
 * List a release in the official MCP Registry (registry.modelcontextprotocol.io).
 *
 *   prepare [version]
 *            Stamp server.json for `version`, by default the one in
 *            package.json (which semantic-release has just written), and
 *            add the Claude Desktop extension as an `mcpb` package: its
 *            release URL and the SHA-256 of release/makemyclip-editor.mcpb.
 *   publish  `mcp-publisher login github-oidc`, then `mcp-publisher publish`.
 *            Retried, since the registry reads the new npm version, which
 *            can take a minute to appear. Needs `mcp-publisher` on PATH and
 *            a GitHub Actions OIDC token (`id-token: write`).
 *
 * server.json is changed in the release job's checkout only; nothing is
 * committed back.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';

const root = resolve(import.meta.dirname, '..');
const serverJsonPath = join(root, 'server.json');
const bundlePath = join(root, 'release', 'makemyclip-editor.mcpb');
const REPO = 'https://github.com/MakeMyClip/editor';

interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  fileSha256?: string;
  transport: { type: string };
  [key: string]: unknown;
}

interface ServerJson {
  version: string;
  packages: RegistryPackage[];
  [key: string]: unknown;
}

async function prepare(versionArg?: string): Promise<void> {
  const version =
    versionArg ??
    (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const server = JSON.parse(await readFile(serverJsonPath, 'utf8')) as ServerJson;
  const sha256 = createHash('sha256')
    .update(await readFile(bundlePath))
    .digest('hex');

  server.version = version;
  const packages = server.packages.filter((p) => p.registryType !== 'mcpb');
  for (const p of packages) if (p.registryType === 'npm') p.version = version;
  packages.push({
    registryType: 'mcpb',
    identifier: `${REPO}/releases/download/v${version}/makemyclip-editor.mcpb`,
    version,
    fileSha256: sha256,
    transport: { type: 'stdio' },
  });
  server.packages = packages;
  await writeFile(serverJsonPath, `${JSON.stringify(server, null, 2)}\n`);
  process.stdout.write(`server.json: ${version}, makemyclip-editor.mcpb sha256 ${sha256}\n`);
}

async function publish(): Promise<void> {
  await execa('mcp-publisher', ['login', 'github-oidc'], { cwd: root, stdio: 'inherit' });
  const attempts = 6;
  for (let attempt = 1; ; attempt++) {
    try {
      await execa('mcp-publisher', ['publish'], { cwd: root, stdio: 'inherit' });
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      process.stderr.write(`mcp-publisher publish failed (attempt ${attempt}); retrying in 20 s\n`);
      await sleep(20_000);
    }
  }
}

const [command, version] = process.argv.slice(2);
const run =
  command === 'prepare' ? () => prepare(version) : command === 'publish' ? publish : undefined;
if (!run) {
  process.stderr.write('Usage: tsx scripts/mcp-registry.ts prepare [version] | publish\n');
  process.exit(1);
}
run().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
