import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/transports/mcp/handlers.js';
import { exportOpenAITools } from '../src/core/schema-export.js';

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
  it('task state retains dated fields at every briefing level', () => {
    const text = description('task_state');
    expect(text).toContain('all briefing levels');
    expect(text).toContain('each field');
    expect(text).toContain('date');
    expect(text).not.toMatch(/one-line flag|not at the default/);
    expect(text).toContain('ONLY what the user actually stated');
  });

  it('names distinguish scoped writes from ordinary user-requested forgetting', () => {
    expect(description('remember')).toContain('returned actual name');
    expect(description('remember')).toContain('full project ID');
    const text = description('forget');
    expect(text).toContain('same-project');
    expect(text).toContain('otherwise uses the supplied name');
    expect(text).toContain('specific observation');
  });

  it('exported briefing describes current task/tails rather than the retired handoff gate', () => {
    const tools = exportOpenAITools() as Array<{ function: { name: string; description: string } }>;
    const text = tools.find(t => t.function.name === 'memesh_briefing')!.function.description;
    expect(text).toContain('all briefing levels');
    expect(text).toContain('three');
    expect(text).toContain('8000 UTF-8 bytes');
    expect(text).not.toMatch(/handoff|14 days|not the default/i);
  });

  it('briefing is called at session start only when the hook has not injected the block', () => {
    const text = description('briefing');
    expect(text).not.toMatch(/Call once at the START of a session/i);
    expect(text).toMatch(/Call at session start only when the host has not already injected the block/);
    expect(text).toContain('or when the user asks what is remembered');
    expect(text).toContain('use recall for specific questions');
    expect(text).toContain('8000 UTF-8 bytes');
    expect(text).not.toContain('4000-character');
  });

  it('user_patterns is not part of loading a session', () => {
    const text = description('user_patterns');
    expect(text).not.toMatch(/at session start/i);
    expect(text).toMatch(/not part of loading a session/);
  });
});
