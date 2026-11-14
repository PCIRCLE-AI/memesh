/** Public conversation bodies are text; retained legacy internal JSON is data. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { handleTool } from '../../src/transports/mcp/handlers.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { executeConversationMessageAction } from '../../src/transports/conversation-messaging.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const db = useTestDatabase('memesh-mcp-payload-nulls-');
const PAYLOAD = { a: null, b: 1, nested: { c: null, d: 2 }, arr: [null, 3] };
const context = { transport: 'http', sourceHost: 'http' } as const;
const legacy = { project: 'proj-517', sender: 'agent-a', recipient: 'agent-b', content_type: 'application/json' };
const textOf = (result: { content: Array<{ text?: string }> }) => result.content[0]?.text ?? '';
const call = (args: Record<string, unknown>, session: string) => handleTool('message', args, 'codex-mcp-client', undefined, { hostSession: session });

beforeEach(() => {
  vi.stubEnv('MEMESH_DIR', db.tmpDir);
  vi.stubEnv('MEMESH_DB_PATH', db.dbPath);
  const store = new ConversationMessages();
  try {
    for (const id of ['A', 'B', 'C']) store.register({ id, host: 'codex', machine: os.hostname(), pid: process.pid, wake: {} });
  } finally { store.close(); }
});
afterEach(() => vi.unstubAllEnvs());

describe('#517 retained legacy internal JSON payload', () => {
  it('preserves null at every depth through internal send and fetch', async () => {
    const sent = await executeAgentMessageAction(getDatabase(), { action: 'send', ...legacy, idempotency_key: 'nested', payload: PAYLOAD }, context) as { message_id: string };
    const fetched = await executeAgentMessageAction(getDatabase(), { action: 'fetch', project: legacy.project, recipient: legacy.recipient, message_id: sent.message_id }, context) as { payload: unknown };
    expect(fetched.payload).toEqual(PAYLOAD);
  });
  it('#553 preserves an explicit null payload and rejects an omitted payload', async () => {
    const sent = await executeAgentMessageAction(getDatabase(), { action: 'send', ...legacy, idempotency_key: 'null', payload: null }, context) as { message_id: string };
    const fetched = await executeAgentMessageAction(getDatabase(), { action: 'fetch', project: legacy.project, recipient: legacy.recipient, message_id: sent.message_id }, context) as Record<string, unknown>;
    expect(fetched).toHaveProperty('payload', null);
    await expect(executeAgentMessageAction(getDatabase(), { action: 'send', ...legacy, idempotency_key: 'missing' }, context)).rejects.toThrow(/payload/i);
  });
});

describe('public MCP conversation text and null validation', () => {
  it('round-trips JSON-looking text unchanged, like the shared conversation executor, and isolates the receiver', async () => {
    const body = JSON.stringify(PAYLOAD);
    const sent = await call({ action: 'send', recipient: 'B', kind: 'task', body }, 'A');
    expect(sent.isError, textOf(sent)).not.toBe(true);
    const id = (JSON.parse(textOf(sent)) as { message_id: string }).message_id;
    const wrong = await call({ action: 'read', message_id: id }, 'C');
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('not addressed to this conversation');
    const status = await call({ action: 'status', message_id: id }, 'A');
    expect(status.isError, textOf(status)).not.toBe(true);
    expect(JSON.parse(textOf(status)).messages[0].events.map((event: { event: string }) => event.event)).toEqual(['queued']);
    const read = await call({ action: 'read', message_id: id }, 'B');
    expect(read.isError, textOf(read)).not.toBe(true);
    expect(JSON.parse(textOf(read)).message.body).toBe(body);
    const shared = executeConversationMessageAction({ action: 'send', recipient: 'B', kind: 'task', body }, { session: 'A' }) as { message_id: string };
    expect(executeConversationMessageAction({ action: 'read', message_id: shared.message_id }, { session: 'B' })).toMatchObject({ message: { body } });
  });
  it('refuses null or missing body, explicit null reply_to and unknown payload without writing', async () => {
    const base = { action: 'send', recipient: 'B', kind: 'task' };
    for (const [args, field] of [
      [{ ...base, body: null }, 'body'],
      [base, 'body'],
      [{ ...base, body: 'valid', reply_to: null }, 'reply_to'],
      [{ ...base, body: 'valid', payload: null }, 'payload'],
    ] as const) {
      const result = await call(args, 'A');
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(field);
    }
    expect(executeConversationMessageAction({ action: 'status' }, { owner: true })).toEqual({ messages: [] });
    const valid = await call({ ...base, body: 'valid' }, 'A');
    expect(valid.isError, textOf(valid)).not.toBe(true);
    expect(JSON.parse(textOf(valid)).state).toBe('queued');
  });
});
