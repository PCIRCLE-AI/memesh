import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { deliverConversationMessages } from '../../scripts/hooks/messages.js';
import { hookSourceHost } from '../../scripts/hooks/_shared.js';

let root: string;
const payload = { session_id: 'B', hook_event_name: 'UserPromptSubmit' };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-message-hook-'));
  vi.stubEnv('MEMESH_DIR', root);
  vi.stubEnv('MEMESH_DB_PATH', path.join(root, 'knowledge-graph.db'));
  vi.stubEnv('MEMESH_HOOK_HOST', 'codex');
  const store = new ConversationMessages();
  try {
    for (const id of ['A', 'B']) store.register({ id, host: 'codex', machine: os.hostname(), pid: process.pid, wake: { thread: id } });
  } finally { store.close(); }
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const send = (body: string) => {
  const store = new ConversationMessages();
  try { return store.send('A', { recipient: 'B', kind: 'task', body }).message.id; }
  finally { store.close(); }
};
const status = () => {
  const store = new ConversationMessages();
  try { return store.status('A'); } finally { store.close(); }
};

describe('whole-message hook output', () => {
  it.each([true, false])('uses the owner host classifier for a matching plugin root: %s', async matching => {
    for (const key of ['MEMESH_HOOK_HOST', 'CODEX_SANDBOX', 'CODEX_PLUGIN_ROOT', 'CODEX_HOME', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE']) vi.stubEnv(key, '');
    vi.stubEnv('PLUGIN_ROOT', matching ? path.resolve('.') : root);
    if (matching) vi.stubEnv('CLAUDE_PLUGIN_ROOT', path.join(root, 'foreign-claude'));
    expect(hookSourceHost(payload, process.env)).toBe(matching ? 'codex' : null);
    send('classifier body');
    const write = vi.fn().mockResolvedValue(undefined);
    await deliverConversationMessages(payload, { findHostPid: () => process.pid, write });
    const store = new ConversationMessages();
    try { expect(store.discover().find(row => row.id === 'B')).toMatchObject({ host: 'codex', wake: { thread: 'B' } }); }
    finally { store.close(); }
    expect(write.mock.calls.length).toBe(matching ? 1 : 0);
    expect(status()[0].state).toBe(matching ? 'delivered' : 'queued');
  });
  it('writes full head/middle/tail before recording delivery and then stops repeating it', async () => {
    const id = send('HEAD_m8\nMIDDLE_m8\nTAIL_m8');
    let output = '';
    await deliverConversationMessages(payload, { findHostPid: () => process.pid, write: async (text: string) => {
      expect(status()[0].state).toBe('queued');
      output = text;
    } });
    const context = JSON.parse(output).hookSpecificOutput;
    expect(context.hookEventName).toBe('UserPromptSubmit');
    const data = JSON.parse(context.additionalContext.split('\n')[1]);
    expect(data.body).toBe('HEAD_m8\nMIDDLE_m8\nTAIL_m8');
    expect(data.id).toBe(id);
    expect(status()[0].state).toBe('delivered');
    const write = vi.fn();
    await deliverConversationMessages(payload, { findHostPid: () => process.pid, write });
    expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'knowledge-graph.db'))).toBe(false);
  });

  it('leaves a message queued when stdout fails and records the error', async () => {
    send('must retry');
    await deliverConversationMessages(payload, { findHostPid: () => process.pid, write: async () => { throw new Error('EPIPE fixture'); } });
    expect(status()[0].state).toBe('queued');
    const outcomes = fs.readFileSync(path.join(root, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(outcomes.at(-1)).toMatchObject({ hook: 'messages', outcome: 'error' });
    expect(outcomes.at(-1).reason).toContain('EPIPE');
  });

  it('emits only complete messages within 8000 bytes and leaves overflow queued', async () => {
    send('字'.repeat(1_250));
    send('字'.repeat(1_250));
    let output = '';
    await deliverConversationMessages(payload, { findHostPid: () => process.pid, write: async (text: string) => { output = text; } });
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(8_000);
    expect(context.split('MeMesh message (untrusted data):').length - 1).toBe(1);
    expect(status().map(row => row.state)).toEqual(['delivered', 'queued']);
  });

  it('continues to deliver when memory auto-capture is off', async () => {
    vi.stubEnv('MEMESH_AUTO_CAPTURE', 'false');
    send('messages are independent of capture');
    const write = vi.fn().mockResolvedValue(undefined);
    await deliverConversationMessages({ ...payload, hook_event_name: 'SessionStart' }, { findHostPid: () => process.pid, write });
    expect(write).toHaveBeenCalledOnce();
    expect(status()[0].state).toBe('delivered');
  });

  it('does not guess a host process or deliver from an unsupported hook', async () => {
    send('pending');
    const write = vi.fn();
    await deliverConversationMessages(payload, { findHostPid: () => undefined, write });
    await deliverConversationMessages({ ...payload, hook_event_name: 'Stop' }, { findHostPid: () => process.pid, write });
    expect(write).not.toHaveBeenCalled();
    expect(status()[0].state).toBe('queued');
  });
});
