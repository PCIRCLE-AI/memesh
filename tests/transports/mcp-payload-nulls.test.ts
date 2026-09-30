/**
 * #517: the MCP boundary drops a null-valued tool PARAMETER (a client that
 * fills blank optional parameters with null means "left blank"), but it must
 * never rewrite the data a parameter carries. A message payload, an import
 * bundle's metadata and a work-package result are stored as sent.
 */
import { describe, expect, it } from 'vitest';
import { handleTool } from '../../src/transports/mcp/handlers.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-mcp-payload-nulls-');

const PROJECT = 'proj-517';
const PAYLOAD = { a: null, b: 1, nested: { c: null, d: 2 }, arr: [null, 3] };

// The result is the first content block. The first MCP call of a process can
// carry an update notice as a SECOND block (handlers.ts), which is not JSON.
function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('Feature: #517 the MCP message tool stores a JSON payload exactly as sent', () => {
  it('keeps null values at every depth of the payload', async () => {
    const sent = await handleTool('message', {
      action: 'send', project: PROJECT, sender: 'agent-a', recipient: 'agent-b',
      idempotency_key: 'k-517', content_type: 'application/json', payload: PAYLOAD,
    }, 'claude-code');
    expect(sent.isError).toBeUndefined();
    const { message_id } = JSON.parse(textOf(sent)) as { message_id: string };

    const fetched = await handleTool('message', {
      action: 'fetch', project: PROJECT, recipient: 'agent-b', message_id,
    }, 'claude-code');
    expect(fetched.isError).toBeUndefined();
    expect(JSON.parse(textOf(fetched)).payload).toEqual(PAYLOAD);
  });

  it('stores the same payload the CLI/HTTP path stores', async () => {
    const viaMcp = await handleTool('message', {
      action: 'send', project: PROJECT, sender: 'agent-a', recipient: 'agent-c',
      idempotency_key: 'k-517-mcp', content_type: 'application/json', payload: PAYLOAD,
    }, 'claude-code');
    const viaShared = await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: PROJECT, sender: 'agent-a', recipient: 'agent-c',
      idempotency_key: 'k-517-shared', content_type: 'application/json', payload: PAYLOAD,
    }, { transport: 'http', sourceHost: 'http' }) as { message_id: string };

    const fetch = async (message_id: string) => JSON.parse(textOf(await handleTool('message', {
      action: 'fetch', project: PROJECT, recipient: 'agent-c', message_id,
    }, 'claude-code'))).payload;
    const mcpId = (JSON.parse(textOf(viaMcp)) as { message_id: string }).message_id;
    expect(await fetch(mcpId)).toEqual(await fetch(viaShared.message_id));
  });

  it('#553 sends a null payload, as the schema and the HTTP path allow', async () => {
    const sent = await handleTool('message', {
      action: 'send', project: PROJECT, sender: 'agent-a', recipient: 'agent-e',
      idempotency_key: 'k-553-mcp', content_type: 'application/json', payload: null,
    }, 'claude-code');
    expect(sent.isError, textOf(sent)).toBeUndefined();
    const { message_id } = JSON.parse(textOf(sent)) as { message_id: string };
    const viaShared = await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: PROJECT, sender: 'agent-a', recipient: 'agent-e',
      idempotency_key: 'k-553-shared', content_type: 'application/json', payload: null,
    }, { transport: 'http', sourceHost: 'http' }) as { message_id: string };

    for (const id of [message_id, viaShared.message_id]) {
      const fetched = await handleTool('message', {
        action: 'fetch', project: PROJECT, recipient: 'agent-e', message_id: id,
      }, 'claude-code');
      expect(fetched.isError).toBeUndefined();
      const body = JSON.parse(textOf(fetched)) as Record<string, unknown>;
      expect(body).toHaveProperty('payload');
      expect(body.payload).toBeNull();
    }
  });

  it('#553 a send that omits the payload is still refused', async () => {
    const sent = await handleTool('message', {
      action: 'send', project: PROJECT, sender: 'agent-a', recipient: 'agent-f',
      idempotency_key: 'k-553-missing', content_type: 'application/json',
    }, 'claude-code');
    expect(sent.isError).toBe(true);
    expect(textOf(sent)).toContain('payload');
  });

  it('still treats a null-valued top-level optional parameter as left blank', async () => {
    const sent = await handleTool('message', {
      action: 'send', project: PROJECT, sender: 'agent-a', recipient: 'agent-d',
      idempotency_key: 'k-517-blank', payload: 'hello', correlation_id: null, reply_to: null,
    }, 'claude-code');
    expect(sent.isError).toBeUndefined();
    const body = JSON.parse(textOf(sent)) as { correlation_id: string | null; reply_to: string | null };
    expect(body.correlation_id).toBeNull();
    expect(body.reply_to).toBeNull();
  });
});
