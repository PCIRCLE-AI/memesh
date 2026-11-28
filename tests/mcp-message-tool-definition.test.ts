import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/transports/mcp/handlers.js';
import { CONVERSATION_MESSAGE_DESCRIPTION, CONVERSATION_MESSAGE_INPUT_SCHEMA, ConversationMessageActionSchema } from '../src/transports/conversation-messaging.js';

describe('public MCP message tool definition', () => {
  it('publishes the strict four-action conversation contract', () => {
    const message = TOOL_DEFINITIONS.find((tool) => tool.name === 'message');
    if (!message) throw new Error('message tool definition missing');

    expect(message.inputSchema).toEqual(CONVERSATION_MESSAGE_INPUT_SCHEMA);
    expect(message.description).toBe(CONVERSATION_MESSAGE_DESCRIPTION);
    for (const input of [
      { action: 'discover' },
      { action: 'send', recipient: 'receiver', kind: 'task', body: 'body' },
      { action: 'read', message_id: '00000000-0000-4000-8000-000000000000' },
      { action: 'status' },
    ]) expect(ConversationMessageActionSchema.safeParse(input).success).toBe(true);
  });

  it('rejects retired routing and lifecycle fields', () => {
    for (const input of [
      { action: 'poll' },
      { action: 'discover', target_kind: 'principal' },
      { action: 'send', recipient: 'receiver', kind: 'task', body: 'body', intended_session: 'session' },
    ]) expect(ConversationMessageActionSchema.safeParse(input).success).toBe(false);
  });
});
