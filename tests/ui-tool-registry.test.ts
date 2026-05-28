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

  it('includes composites with primitive-only schemas (v0.3 onward)', () => {
    // add_title_card joined the registry in v0.3 — its schema is all
    // primitives so the generic form pattern works. Composites with
    // structured inputs (add_captions cues, highlight_reel segments)
    // stay excluded until they get bespoke UI.
    expect(TOOL_REGISTRY.add_title_card).toBeDefined();
    expect(typeof TOOL_REGISTRY.add_title_card?.fn).toBe('function');
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

  it('returns true for composites with primitive schemas (v0.3)', () => {
    expect(isRegisteredTool('add_title_card')).toBe(true);
  });

  it('returns false for excluded tools (structured composites, safety, transform)', () => {
    // Still excluded — schemas need bespoke UI or are meta-ops
    expect(isRegisteredTool('add_captions')).toBe(false);
    expect(isRegisteredTool('silence_remove')).toBe(false);
    expect(isRegisteredTool('highlight_reel')).toBe(false);
    expect(isRegisteredTool('snapshot')).toBe(false);
    expect(isRegisteredTool('undo')).toBe(false);
    expect(isRegisteredTool('inspect')).toBe(false);
    expect(isRegisteredTool('delete')).toBe(false);
    expect(isRegisteredTool('chroma_key')).toBe(false);
    expect(isRegisteredTool('transform')).toBe(false);
  });
});
