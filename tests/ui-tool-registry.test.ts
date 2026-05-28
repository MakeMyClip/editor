import { describe, expect, it } from 'vitest';
import { isRegisteredTool, TOOL_REGISTRY } from '../src/ui/tool-registry.js';

describe('TOOL_REGISTRY', () => {
  it('includes the v0.2 form-backed tools', () => {
    for (const name of ['trim', 'split', 'add_text', 'transition', 'render']) {
      expect(TOOL_REGISTRY[name]).toBeDefined();
      expect(typeof TOOL_REGISTRY[name]?.fn).toBe('function');
      expect(TOOL_REGISTRY[name]?.schema).toBeDefined();
    }
  });

  it('includes Phase 2 and 4 tools that have UI value', () => {
    for (const name of ['adjust', 'speed', 'overlay', 'zoom_pan', 'stabilize']) {
      expect(TOOL_REGISTRY[name]).toBeDefined();
    }
  });

  it('includes composites once the UI has a form for them (v0.3 / v0.5)', () => {
    // add_title_card joined in v0.3 (primitive schema). The rest joined in
    // v0.5 once the row-list form pattern proved out for structured input.
    for (const name of [
      'add_title_card',
      'chroma_key',
      'silence_remove',
      'highlight_reel',
      'add_captions',
    ]) {
      expect(TOOL_REGISTRY[name], `${name} should be registered`).toBeDefined();
      expect(typeof TOOL_REGISTRY[name]?.fn).toBe('function');
    }
  });

  it('every entry has both schema and fn', () => {
    for (const [name, entry] of Object.entries(TOOL_REGISTRY)) {
      expect(entry.schema, `schema for ${name}`).toBeDefined();
      expect(typeof entry.fn, `fn for ${name}`).toBe('function');
    }
  });

  it('schemas reject obviously invalid input (catches accidental wrong wiring)', () => {
    // Each schema is its tool's input — minimal invariant: empty object
    // fails (every tool requires at least an input/path field, or some
    // refinement). If a schema accepts {} we've miswired which schema
    // belongs to which tool.
    for (const [name, entry] of Object.entries(TOOL_REGISTRY)) {
      const parsed = entry.schema.safeParse({});
      expect(parsed.success, `${name} schema should reject {}`).toBe(false);
    }
  });
});

describe('isRegisteredTool', () => {
  it('returns true for known tools', () => {
    expect(isRegisteredTool('trim')).toBe(true);
    expect(isRegisteredTool('add_text')).toBe(true);
  });

  it('returns false for unknown tools', () => {
    expect(isRegisteredTool('nope')).toBe(false);
    expect(isRegisteredTool('')).toBe(false);
    expect(isRegisteredTool('TRIM')).toBe(false); // case-sensitive
  });

  it('returns true for all v0.3 / v0.5 composites', () => {
    for (const name of [
      'add_title_card',
      'chroma_key',
      'silence_remove',
      'highlight_reel',
      'add_captions',
    ]) {
      expect(isRegisteredTool(name), name).toBe(true);
    }
  });

  it('returns false for session-management and discriminated-union tools', () => {
    // Snapshot/undo/inspect/delete are meta-ops served by dedicated endpoints
    // (POST /api/session/snapshot, /api/session/undo, etc.) rather than the
    // generic tool dispatch. transform is a discriminated union that needs
    // bespoke UI.
    expect(isRegisteredTool('snapshot')).toBe(false);
    expect(isRegisteredTool('undo')).toBe(false);
    expect(isRegisteredTool('inspect')).toBe(false);
    expect(isRegisteredTool('delete')).toBe(false);
    expect(isRegisteredTool('transform')).toBe(false);
  });
});
