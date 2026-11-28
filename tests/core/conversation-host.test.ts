import { describe, expect, it } from 'vitest';
import { mcpConversationSession } from '../../src/core/conversation-host.js';

describe('conversation identity from the host', () => {
  it('uses the current Codex call, including the measured native client name', () => {
    const env = { CODEX_THREAD_ID: 'wrong-thread', CLAUDE_CODE_SESSION_ID: 'wrong-claude' };
    expect(mcpConversationSession('codex-mcp-client', { threadId: 'A' }, env)).toBe('A');
    expect(mcpConversationSession('codex-mcp-client', { threadId: 'B' }, env)).toBe('B');
    expect(mcpConversationSession('Codex', { threadId: 'C' }, env)).toBe('C');
    expect(mcpConversationSession('codex', {}, env)).toBeUndefined();
    expect(mcpConversationSession('codex', { threadId: '/tmp/wrong' }, env)).toBeUndefined();
  });
  it('uses Claude session env and never another host or a model argument', () => {
    expect(mcpConversationSession('claude-code', { threadId: 'wrong' }, { CLAUDE_CODE_SESSION_ID: 'claude-session' })).toBe('claude-session');
    expect(mcpConversationSession('unknown', { threadId: 'wrong' }, { CLAUDE_CODE_SESSION_ID: 'claude-session' })).toBeUndefined();
    expect(mcpConversationSession('claude-code', {}, { CLAUDE_CODE_SESSION_ID: '../escape' })).toBeUndefined();
  });
});
