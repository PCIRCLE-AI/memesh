import { describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { sendAgentMessage, type SendAgentMessageInput } from '../../src/core/agent-messaging.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-agent-message-loop-');

const PROJECT = 'loop-project';

function tables() {
  const db = getDatabase();
  return Object.fromEntries([
    'agent_messages',
    'agent_message_deliveries',
    'agent_message_events',
    'agent_message_idempotency',
  ].map((table) => [table, (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
}

function send(key: string, sender = 'codex-a', recipient = 'claude-b', provenance?: SendAgentMessageInput['provenance'], project = PROJECT) {
  return sendAgentMessage(getDatabase(), {
    project,
    sender,
    recipient,
    idempotency_key: key,
    content_type: 'text/plain',
    payload: 'continue the task',
    ...(provenance === undefined ? {} : { provenance }),
  });
}

function loopError(key: string) {
  try {
    send(key);
    return undefined;
  } catch (error) {
    return error as { code?: string };
  }
}

describe('agent message conversation loop guard', () => {
  it('counts principal replies when each sender identifies its own session', () => {
    for (let index = 0; index < 30; index += 1) {
      const forward = index % 2 === 0;
      send(`principal-reply-${index}`, forward ? 'codex-thread-X' : 'claude-p', forward ? 'claude-p' : 'codex-thread-X', {
        sender_session: forward ? 'X' : 'C',
      });
    }
    const before = tables();
    let error: unknown;
    try {
      send('principal-reply-31', 'codex-thread-X', 'claude-p', { sender_session: 'X' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'conversation_loop_suspected' });
    expect(tables()).toEqual(before);
  });

  it('accepts 30 messages, rejects the 31st atomically, and still permits a retry of the 30th', () => {
    let thirtieth: ReturnType<typeof send> | undefined;
    for (let index = 1; index <= 30; index += 1) {
      thirtieth = send(`loop-${index}`, index % 2 === 0 ? 'claude-b' : 'codex-a', index % 2 === 0 ? 'codex-a' : 'claude-b');
    }
    expect(tables()).toEqual({
      agent_messages: 30,
      agent_message_deliveries: 30,
      agent_message_events: 30,
      agent_message_idempotency: 30,
    });

    expect(loopError('loop-31')).toMatchObject({ code: 'conversation_loop_suspected' });
    expect(tables()).toEqual({
      agent_messages: 30,
      agent_message_deliveries: 30,
      agent_message_events: 30,
      agent_message_idempotency: 30,
    });
    expect(send('loop-30', 'claude-b', 'codex-a')).toMatchObject({ message_id: thirtieth!.message_id });
  });

  it('does not count a message from more than ten minutes ago', () => {
    for (let index = 1; index <= 30; index += 1) send(`old-${index}`);
    getDatabase().prepare(`
      UPDATE agent_messages SET created_at = '2000-01-01 00:00:00'
      WHERE project = ?
    `).run(PROJECT);
    expect(send('after-old')).toMatchObject({ project: PROJECT });
  });

  it('does not merge a different project into this conversation', () => {
    for (let index = 1; index <= 30; index += 1) send(`other-project-${index}`, 'codex-a', 'claude-b', undefined, 'other-project');
    expect(send('this-project')).toMatchObject({ project: PROJECT });
  });

  it('accepts legacy provenance on an exact retry and does not add another row', () => {
    const legacy = send('legacy-retry', 'old-codex', 'old-claude', { transport: 'cli', source_host: 'cli' });
    const before = tables();
    expect(send('legacy-retry', 'old-codex', 'old-claude', { transport: 'cli', source_host: 'cli' }))
      .toMatchObject({ message_id: legacy.message_id });
    expect(tables()).toEqual(before);
  });
});
