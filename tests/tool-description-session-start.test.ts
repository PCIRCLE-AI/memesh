import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/transports/mcp/handlers.js';

/**
 * #444: the MCP descriptions are what every host's agent reads before deciding
 * to call a tool. They told the agent to call `briefing` and `user_patterns`
 * at every session start, while the SessionStart hook (Claude Code, the Codex
 * plugin) had already injected the same block — so the block was loaded twice.
 */
const description = (name: string) => {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  expect(tool, name).toBeDefined();
  return tool!.description;
};

describe('session-start guidance in MCP tool descriptions (#444)', () => {
  it('briefing is called at session start only when the hook has not injected the block', () => {
    const text = description('briefing');
    expect(text).not.toMatch(/Call once at the START of a session/i);
    expect(text).toMatch(/only when the host has not already injected this block/);
    expect(text).toMatch(/Codex plugin/);
  });

  it('user_patterns is not part of loading a session', () => {
    const text = description('user_patterns');
    expect(text).not.toMatch(/at session start/i);
    expect(text).toMatch(/not part of loading a session/);
  });
});
