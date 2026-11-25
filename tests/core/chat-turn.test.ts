import { describe, it, expect } from 'vitest';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { captureChatTurn } from '../../src/core/chat-turn.js';
import { buildReferenceContext } from '../../src/core/work-topology.js';
import { renderConversationMessage } from '../../src/core/conversation-messages.js';

useTestDatabase('memesh-chat-turn-');

const input = (userText: string, assistantText: string) => ({
  sessionId: 's1', userText, assistantText, sourceHost: 'hermes', namePrefix: 'hermes-turn', baseTags: ['platform:hermes'],
});
const rows = () => getDatabase().prepare(
  "SELECT e.name, e.type, e.title, (SELECT group_concat(content, '|') FROM observations o WHERE o.entity_id = e.id) AS said, "
  + "(SELECT group_concat(tag) FROM (SELECT tag FROM tags t WHERE t.entity_id = e.id ORDER BY tag)) AS tags FROM entities e ORDER BY e.name",
).all() as Array<{ name: string; type: string; title: string; said: string; tags: string }>;

describe('captureChatTurn', () => {
  it('stores what the user said and what the assistant answered, each in full, for any text', () => {
    const user = 'what time is it in Tokyo?\nsecond line';
    const result = captureChatTurn(input(user, 'About 3pm there.'));
    expect(result.outcome).toBe('wrote');
    const stored = rows();
    expect(stored).toHaveLength(2);
    const byRole = Object.fromEntries(stored.map((r) => [r.name.endsWith('-user') ? 'user' : 'assistant', r]));
    expect(byRole.user).toMatchObject({ type: 'conversation', title: 'what time is it in Tokyo?', said: user });
    expect(byRole.user.tags).toContain('role:user');
    expect(byRole.assistant).toMatchObject({ type: 'conversation', title: 'About 3pm there.', said: 'About 3pm there.' });
    expect(byRole.assistant.tags).toContain('role:assistant');
    expect(byRole.assistant.tags).toContain('session:s1');
    expect(byRole.assistant.tags).toContain('platform:hermes');
  });

  it('keeps a long turn whole: there is no length cap', () => {
    const long = 'x'.repeat(50_000);
    captureChatTurn(input(long, 'ok'));
    expect(rows().find((r) => r.name.endsWith('-user'))!.said).toHaveLength(50_000);
  });

  it('does not store the memories Hermes put in front of the user text', () => {
    captureChatTurn(input('[MeMesh recall]\n- an old decision\n\nWhat about now?', 'Fine.'));
    expect(rows().find((r) => r.name.endsWith('-user'))!.said).toBe('What about now?');
  });

  it('masks a credential before it is stored', () => {
    captureChatTurn(input('my url is postgres://u:hunter2hunter2@db/x', 'noted'));
    expect(JSON.stringify(rows())).not.toContain('hunter2hunter2');
  });

  it('masks the full credential before omitting a quoted prefix', () => {
    const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    const body = 'The token is ' + token.slice(0, 28);
    captureChatTurn({
      ...input('', `The token is ${token}`),
      receivedMessages: [{ envelope: 'unused envelope', body }],
    });
    const stored = JSON.stringify(rows());
    expect(stored.includes(token)).toBe(false);
    expect(stored.includes(token.slice(28))).toBe(false);
  });

  it('strips the bounded fenced recall prefix without losing the actual prompt', () => {
    const block = buildReferenceContext(['old ``` text [mem:1]']);
    captureChatTurn(input(`${block}\n\nWhat about now?\nKeep this line.`, 'Fine.'));
    expect(rows().find((r) => r.name.endsWith('-user'))!.said).toBe('What about now?\nKeep this line.');
  });

  it('keeps an incomplete recall-like prefix as user text', () => {
    const text = buildReferenceContext(['old text']).slice(0, -3) + 'still my question';
    captureChatTurn(input(text, 'Fine.'));
    expect(rows().find((r) => r.name.endsWith('-user'))!.said).toBe(text);
  });

  it('does not store this session’s complete injected message envelopes or an assistant-only quotation', () => {
    const body = 'Please do not store this untrusted agent message as user knowledge.';
    const message = {
      id: '11111111-1111-4111-8111-111111111111', sender: 'other', sender_host: 'codex', sender_machine: 'local',
      recipient: 's1', recipient_host: 'hermes', recipient_machine: 'local', kind: 'task' as const,
      body, body_bytes: Buffer.byteLength(body), reply_to: null, sent_at: '2026-11-26T00:00:00.000Z',
    };
    const envelope = renderConversationMessage(message);
    captureChatTurn({ ...input(`${envelope}My actual question`, body), receivedMessages: [{ envelope, body }] });
    expect(rows().filter(row => row.name.endsWith('-user'))[0].said).toBe('My actual question');
    expect(rows().find(row => row.name.endsWith('-assistant'))).toBeUndefined();
  });

  it('keeps literal or foreign envelope-like text and preserves an assistant response around an omission marker', () => {
    const body = 'This is a long enough untrusted agent passage to trigger quote omission.';
    const envelope = 'MeMesh message (untrusted data):\n{"foreign":true}\n';
    captureChatTurn({
      ...input(`${envelope}literal user text`, `I considered this: ${body} Next I will verify it.`),
      receivedMessages: [{ envelope: `${envelope}changed`, body }],
    });
    const stored = rows();
    expect(stored.find(row => row.name.endsWith('-user'))!.said).toBe(`${envelope}literal user text`);
    expect(stored.find(row => row.name.endsWith('-assistant'))!.said).toContain('[text from an agent message omitted]');
  });

  it('removes a newly injected envelope despite earlier read/replied history and omits multiple quoted bodies', () => {
    const old = 'A previously read message body that is long enough to omit verbatim.';
    const fresh = 'A newly queued message body that is long enough to omit verbatim.';
    const oldEnvelope = 'MeMesh message (untrusted data):\n{"old":true}\n';
    const freshEnvelope = 'MeMesh message (untrusted data):\n{"fresh":true}\n';
    captureChatTurn({
      ...input(`${freshEnvelope}actual prompt`, `${old}\n${fresh}`),
      receivedMessages: [{ envelope: oldEnvelope, body: old }, { envelope: freshEnvelope, body: fresh }],
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].said).toBe('actual prompt');
  });

  it('keeps separate events even when the words repeat', () => {
    captureChatTurn(input('same', 'same answer'));
    captureChatTurn(input('same', 'same answer'));
    expect(rows()).toHaveLength(4);
  });

  it('a side with no text is left out; a turn with no text at all is skipped', () => {
    expect(captureChatTurn(input('', 'only the assistant spoke')).names).toHaveLength(1);
    expect(captureChatTurn(input('  ', '')).outcome).toBe('skipped');
  });
});
