import { describe, it, expect } from 'vitest';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { captureChatTurn } from '../../src/core/chat-turn.js';
import { buildReferenceContext } from '../../src/core/work-topology.js';

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
