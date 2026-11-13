import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { executeConversationMessageAction, ConversationMessageActionSchema } from '../../src/transports/conversation-messaging.js';
import { handleTool } from '../../src/mcp/tools.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-conversation-transport-'));
  vi.stubEnv('MEMESH_DIR', root);
  vi.stubEnv('MEMESH_DB_PATH', path.join(root, 'knowledge-graph.db'));
  const store = new ConversationMessages();
  try {
    for (const id of ['A', 'B', 'C']) store.register({ id, host: id === 'A' ? 'claude-code' : 'codex', machine: os.hostname(), pid: process.pid, wake: {} });
  } finally { store.close(); }
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('four conversation message actions', () => {
  it('supports send/read/reply/status with no graph or project', () => {
    const sent = executeConversationMessageAction({ action: 'send', recipient: 'B', kind: 'question', body: 'START MID END' }, { session: 'A' }) as { message_id: string };
    expect(executeConversationMessageAction({ action: 'read', message_id: sent.message_id }, { session: 'B' })).toMatchObject({ message: { body: 'START MID END' } });
    expect(() => executeConversationMessageAction({ action: 'read', message_id: sent.message_id }, { session: 'C' })).toThrow();
    expect(executeConversationMessageAction({ action: 'status' }, { session: 'C' })).toEqual({ messages: [] });
    expect(executeConversationMessageAction({ action: 'discover' }, {})).toMatchObject({ conversations: [
      { address: 'A', host: 'claude-code' }, { address: 'B', host: 'codex' }, { address: 'C', host: 'codex' },
    ] });
    expect(fs.existsSync(path.join(root, 'knowledge-graph.db'))).toBe(false);
  });
  it('fails closed without per-call identity and refuses sender/owner/project or retired actions as input', () => {
    expect(() => executeConversationMessageAction({ action: 'status' }, {})).toThrow('identity_unavailable');
    expect(() => executeConversationMessageAction({ action: 'send', recipient: 'B', kind: 'task', body: 'x' }, { owner: true })).toThrow('identity_unavailable');
    for (const action of ['delete', 'update', 'poll', 'fetch', 'intake', 'receipts']) expect(ConversationMessageActionSchema.safeParse({ action }).success).toBe(false);
    for (const key of ['sender', 'owner', 'project', 'hostSession']) expect(ConversationMessageActionSchema.safeParse({ action: 'status', [key]: 'A' }).success).toBe(false);
  });
  it('returns an error while preserving rejected sends for the owner audit', () => {
    expect(() => executeConversationMessageAction({ action: 'send', recipient: 'missing', kind: 'task', body: 'audit me' }, { session: 'A' })).toThrow('unknown_recipient');
    expect(() => executeConversationMessageAction({ action: 'send', recipient: 'B', kind: 'task', body: '密'.repeat(8_000) }, { session: 'A' })).toThrow('message_too_large');
    const status = executeConversationMessageAction({ action: 'status' }, { owner: true }) as { messages: Array<{ body: string | null; state: string }> };
    expect(status.messages.map(row => row.state)).toEqual(['rejected', 'rejected']);
    expect(status.messages[0].body).toBe('audit me');
    expect(status.messages[1].body).toBeNull();
  });
  it('MCP uses host context and cannot promote itself to owner audit', async () => {
    const sent = await handleTool('message', { action: 'send', recipient: 'B', kind: 'task', body: 'native marker' }, 'codex-mcp-client', undefined, { hostSession: 'A' });
    expect(sent.isError).not.toBe(true);
    const id = JSON.parse(sent.content[0].text).message_id;
    const wrong = await handleTool('message', { action: 'read', message_id: id }, 'codex-mcp-client', undefined, { hostSession: 'C' });
    expect(wrong.isError).toBe(true);
    const read = await handleTool('message', { action: 'read', message_id: id }, 'codex-mcp-client', undefined, { hostSession: 'B' });
    expect(read.isError).not.toBe(true);
    expect(JSON.parse(read.content[0].text).message.body).toBe('native marker');
    expect((await handleTool('message', { action: 'status' }, 'codex-mcp-client')).isError).toBe(true);
    expect((await handleTool('message', { action: 'status', owner: true }, 'codex-mcp-client', undefined, { hostSession: 'C' })).isError).toBe(true);
  });
});
