/**
 * List a release in the official MCP Registry (registry.modelcontextprotocol.io).
 *
 *   prepare [version]
 *            Stamp server.json for `version`, by default the one in
 *            package.json (which semantic-release has just written), and
 *            add the Claude Desktop extension as an `mcpb` package: its
 *            release URL and the SHA-256 of release/makemyclip-editor.mcpb.
 *   publish  Wait until npm serves the version in server.json (the registry
 *            refuses a version npm doesn't have yet, and npm can take several
 *            minutes after `npm publish` to serve it), then
 *            `mcp-publisher login github-oidc` and `mcp-publisher publish`,
 *            retried for registry hiccups. Needs `mcp-publisher` on PATH and
 *            a GitHub Actions OIDC token (`id-token: write`).
 *
 * server.json is changed in the release job's checkout only; nothing is
 * committed back.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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

export interface WaitForNpmOptions {
  registryBaseUrl: string;
  identifier: string;
  version: string;
  /** Give up after this long, request time included; npm has taken over 4
   *  minutes to serve a new version. */
  timeoutMs?: number;
  intervalMs?: number;
  /** One request; `timeoutMs` bounds it. Rejects on a network error. */
  fetch?: (url: string, timeoutMs: number) => Promise<{ status: number }>;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
}

/** Longest a single request may take, so one hung connection can't eat the wait. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Poll npm for one version's metadata until it answers 200. The registry's own
 * check reads the same metadata, so publishing before this passes only fails.
 * A network error counts as "not yet" and is retried until the deadline.
 */
export async function waitForNpmVersion(options: WaitForNpmOptions): Promise<void> {
  const {
    registryBaseUrl,
    identifier,
    version,
    timeoutMs = 20 * 60_000,
    intervalMs = 20_000,
    fetch: get = (url, ms) =>
      fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(ms) }),
    sleep: wait = sleep,
    now = Date.now,
    log = (line) => process.stderr.write(`${line}\n`),
  } = options;
  // Scoped names keep their @ but escape the slash: @scope%2fname.
  const url = `${registryBaseUrl.replace(/\/$/, '')}/${identifier.replace('/', '%2f')}/${version}`;
  const start = now();
  const deadline = start + timeoutMs;
  for (;;) {
    let answer: string;
    try {
      const { status } = await get(
        url,
        Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - now())),
      );
      if (status === 200) return;
      answer = `answers ${status}`;
    } catch (err) {
      answer = `failed (${err instanceof Error ? err.message : String(err)})`;
    }
    const left = deadline - now();
    if (left <= 0) {
      throw new Error(
        `npm still ${answer} for ${identifier}@${version} after ${Math.round((now() - start) / 1000)} s (${url}); list it by hand once npm serves it (RELEASING.md).`,
      );
    }
    const pause = Math.min(intervalMs, left);
    log(
      `npm ${answer} for ${identifier}@${version}; checking again in ${Math.round(pause / 1000)} s`,
    );
    await wait(pause);
  }
}

async function publish(): Promise<void> {
  const server = JSON.parse(await readFile(serverJsonPath, 'utf8')) as ServerJson;
  for (const p of server.packages) {
    if (p.registryType !== 'npm') continue;
    await waitForNpmVersion({
      registryBaseUrl: String(p.registryBaseUrl ?? 'https://registry.npmjs.org'),
      identifier: p.identifier,
      version: p.version ?? server.version,
    });
  }
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

// Run as a command only, so tests can import waitForNpmVersion.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
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
}
