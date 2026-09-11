import { describe, it, expect } from 'vitest';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { classifyTurn, captureChatTurn } from '../../src/core/turn-signal.js';

describe('classifyTurn', () => {
  it.each([
    ['Which DB?', "We decided to use SQLite over Postgres for the local store."],
    ["Let's go with pnpm for this repo.", 'OK.'],
    ['用哪個？', '決定改用 node:sqlite。'],
  ])('flags a decision: %s / %s', (u, a) => {
    expect(classifyTurn(u, a)?.kind).toBe('decision');
  });

  it.each([
    ['Why did it fail?', 'The root cause was a stale plugin cache keyed by version.'],
    ['', 'It turned out the env var was passed as an argument, not as env.'],
    ['為什麼？', '根因是快取沒有更新。'],
  ])('flags a lesson: %s / %s', (u, a) => {
    expect(classifyTurn(u, a)?.kind).toBe('lesson');
  });

  it.each([
    ['hi', 'Hello! How can I help?'],
    ['What time is it in Tokyo?', 'It is about 3pm there.'],
    ['List the files', 'Here are the files: a.ts, b.ts'],
  ])('ignores ordinary conversation: %s', (u, a) => {
    expect(classifyTurn(u, a)).toBeNull();
  });
});

describe('captureChatTurn', () => {
  useTestDatabase('memesh-turn-signal-');
  const count = () => (getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'conversation'").get() as { n: number }).n;
  const base = { sessionId: 's9', sourceHost: 'hermes', namePrefix: 'hermes-turn', baseTags: ['platform:hermes'] };

  it('stores nothing for a turn without a decision- or lesson-shaped move', () => {
    const r = captureChatTurn({ ...base, userText: 'hi', assistantText: 'Hello!' });
    expect(r.outcome).toBe('skipped');
    expect(count()).toBe(0);
  });

  it('stores exactly one row for a decision turn, idempotent on retry, stamped with the host', () => {
    const turn = { ...base, userText: 'Which queue?', assistantText: "We decided to use BullMQ." };
    const r = captureChatTurn(turn);
    captureChatTurn(turn);
    expect(r.outcome).toBe('wrote');
    expect(r.kind).toBe('decision');
    expect(count()).toBe(1);
    const row = getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(r.name!) as { metadata: string };
    expect(JSON.parse(row.metadata).provenance.source_host).toBe('hermes');
    const tags = (getDatabase().prepare(
      'SELECT tag FROM tags WHERE entity_id = (SELECT id FROM entities WHERE name = ?)',
    ).all(r.name!) as Array<{ tag: string }>).map((t) => t.tag);
    expect(tags).toEqual(expect.arrayContaining(['platform:hermes', 'session:s9', 'signal:decision']));
  });
});
