import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeVerbContext } from '../src/ui/timeline-tools.js';
import { TOOL_REGISTRY } from '../src/ui/tool-registry.js';
import { resolveInput, resolveInWorkspace, WorkspaceBoundaryError } from '../src/workspace.js';

let workspace: string;
let saved: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-ws-test-'));
  saved = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = saved;
  await rm(workspace, { recursive: true, force: true });
});

describe('resolveInWorkspace (untrusted-input confinement)', () => {
  it('accepts an absolute path inside the workspace', () => {
    const p = resolve(workspace, 'imports/clip.mp4');
    expect(resolveInWorkspace(p)).toBe(p);
  });

  it('resolves a relative path against the workspace', () => {
    expect(resolveInWorkspace('imports/clip.mp4')).toBe(resolve(workspace, 'imports/clip.mp4'));
  });

  it('rejects parent-traversal paths', () => {
    expect(() => resolveInWorkspace('../escape.mp4')).toThrow(WorkspaceBoundaryError);
    expect(() => resolveInWorkspace(resolve(workspace, '../sibling/secret.mov'))).toThrow(
      WorkspaceBoundaryError,
    );
  });

  it('rejects an absolute path outside the workspace', () => {
    expect(() => resolveInWorkspace('/etc/passwd')).toThrow(WorkspaceBoundaryError);
  });

  it('rejects the workspace directory itself (not a file)', () => {
    expect(() => resolveInWorkspace(workspace)).toThrow(WorkspaceBoundaryError);
  });

  it('does not confuse a file named "..foo" with traversal', () => {
    const p = resolve(workspace, '..foo.mp4');
    expect(resolveInWorkspace(p)).toBe(p);
  });

  it('the CLI resolver stays UNCONFINED (a user-typed path is consent)', () => {
    expect(resolveInput('/etc/passwd')).toBe('/etc/passwd');
  });
});

describe('the agent/UI ingest surfaces are gated', () => {
  it('the registry-dispatched ingest tool rejects out-of-workspace paths before probing', async () => {
    await expect(TOOL_REGISTRY.ingest.fn({ path: '/etc/passwd' })).rejects.toBeInstanceOf(
      WorkspaceBoundaryError,
    );
  });

  it("makeVerbContext().ingest (the add_media verb's path) rejects out-of-workspace paths", async () => {
    await expect(makeVerbContext().ingest('/etc/passwd')).rejects.toBeInstanceOf(
      WorkspaceBoundaryError,
    );
  });
});

describe('every path-bearing registry tool is confined, not just ingest', () => {
  // The other registry tools (render/trim/overlay/…) are reachable from the same
  // untrusted surfaces (POST /api/tools/:name, the agent's tool calls). Each reads
  // its source path(s) with FFmpeg, so each must reject out-of-workspace input —
  // otherwise it's an arbitrary-file read (the rendered output is served back).

  it('a single-input tool (render) rejects an out-of-workspace input before probing', async () => {
    await expect(TOOL_REGISTRY.render.fn({ input: '/etc/passwd' })).rejects.toBeInstanceOf(
      WorkspaceBoundaryError,
    );
  });

  it('trim rejects an out-of-workspace input', async () => {
    await expect(
      TOOL_REGISTRY.trim.fn({ input: '/etc/passwd', startSec: 0, endSec: 1 }),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });

  it('confines EVERY path field — a valid input with an escaping second path is rejected', async () => {
    const inside = resolve(workspace, 'imports/clip.mp4');
    // add_audio confines both `input` and `audio`; the escape is in the 2nd field.
    await expect(
      TOOL_REGISTRY.add_audio.fn({ input: inside, audio: '/etc/passwd' }),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });

  it('confines array-of-path inputs (concat) element-wise', async () => {
    const inside = resolve(workspace, 'imports/a.mp4');
    await expect(
      TOOL_REGISTRY.concat.fn({ inputs: [inside, '/etc/passwd'] }),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });
});
