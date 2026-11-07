/**
 * Build the Claude Desktop extension, `release/makemyclip-editor.mcpb`:
 * the built CLI and its production dependencies, without FFmpeg. The Apple
 * Silicon build ffmpeg-static downloads isn't redistributable, so the extension
 * runs the FFmpeg the user installs (see the README's License section).
 * Run `pnpm build` first.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'build', 'mcpb');
const outDir = join(root, 'release');

async function main(): Promise<void> {
  if (!existsSync(join(root, 'dist', 'cli.js'))) {
    throw new Error('dist/cli.js is missing: run `pnpm build` first.');
  }
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };

  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'README.md',
    'LICENSE',
  ]) {
    await cp(join(root, file), join(stage, file));
  }
  await cp(join(root, 'dist'), join(stage, 'dist'), {
    recursive: true,
    filter: (src) => !src.endsWith('.d.ts'),
  });
  await cp(join(root, 'logo.png'), join(stage, 'icon.png'));

  // A flat production install, the layout npm makes: `mcpb pack` follows
  // symlinks, so pnpm's default layout would pack its whole store.
  // --ignore-scripts keeps ffmpeg-static from downloading FFmpeg.
  await execa(
    'pnpm',
    ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--config.node-linker=hoisted'],
    { cwd: stage, stdio: 'inherit' },
  );
  const ffmpegStaticDir = join(stage, 'node_modules', 'ffmpeg-static');
  const binaries = (await readdir(ffmpegStaticDir)).filter((f) => /^ffmpeg(\.exe)?$/.test(f));
  if (binaries.length > 0) {
    throw new Error(
      `FFmpeg must not ship in the extension, but ${ffmpegStaticDir} has ${binaries}.`,
    );
  }

  const manifest = JSON.parse(await readFile(join(root, 'mcpb', 'manifest.json'), 'utf8')) as {
    version: string;
  };
  manifest.version = version;
  await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(stage, '.mcpbignore'),
    [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'node_modules/.pnpm',
      'node_modules/.modules.yaml',
      '',
    ].join('\n'),
  );

  await mkdir(outDir, { recursive: true });
  // No version in the name, so `releases/latest/download/makemyclip-editor.mcpb`
  // is a stable link to the newest one.
  const output = join(outDir, 'makemyclip-editor.mcpb');
  const mcpb = { cwd: root, preferLocal: true, stdio: 'inherit' } as const;
  await execa('mcpb', ['validate', join(stage, 'manifest.json')], mcpb);
  await execa('mcpb', ['pack', stage, output], mcpb);
  process.stdout.write(`${output}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
