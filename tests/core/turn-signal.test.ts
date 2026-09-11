import { describe, it, expect } from 'vitest';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { classifyTurn, captureChatTurn } from '../../src/core/turn-signal.js';

describe('classifyTurn', () => {
  it.each([
    ['Which DB?', "We decided to use SQLite over Postgres for the local store."],
    ['Which package manager?', "Let's go with pnpm for this repo."],
    ['用哪個？', '決定改用 node:sqlite。'],
  ])('flags a decision: %s / %s', (u, a) => {
    expect(classifyTurn(u, a)?.kind).toBe('decision');
  });

  it.each([
    ['Why did it fail?', 'The root cause was a stale plugin cache keyed by version.'],
    ['', 'Lesson learned: the env var was passed as an argument, not as env.'],
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

  // Review F1: twelve real turns measured against the first version, which
  // matched cue substrings anywhere in user+assistant text, with no negation.
  it.each([
    ['What time is it in Tokyo?', 'It turns out Tokyo is 13 hours ahead of New York right now.'],
    ['Have we decided on the DB yet?', 'Not yet — still comparing options.'],
    ['I chose the wrong file, sorry', 'No problem, send me the right one.'],
    ['還沒決定要用哪個', '好，等你確認'],
    ['Can you fix it?', 'The issue is that I cannot see your screen from here.'],
    ['Thanks', 'Next time you visit Kyoto, try the tofu.'],
    ['Which DB?', 'We have not decided yet; still comparing.'],
    ['Which DB?', '還沒決定，還在比較。'],
  ])('no false positive: %s / %s', (u, a) => {
    expect(classifyTurn(u, a)).toBeNull();
  });

  it.each([
    ['Which queue?', 'We are going to use BullMQ for the job queue.', 'decision'],
    ['Which queue?', 'Use BullMQ instead of Redis lists.', 'decision'],
    ['', 'Switching to pnpm; npm workspaces were too slow.', 'decision'],
    ['', 'Agreed: SQLite stays the store.', 'decision'],
    ['', 'Learned the hard way that the env var must come first.', 'lesson'],
  ])('no false negative: %s / %s', (u, a, kind) => {
    expect(classifyTurn(u, a)?.kind).toBe(kind);
  });

  // Re-review P2-a: a negation in an EARLIER clause must not cancel the cue.
  it.each([
    ['Which queue?', 'No — we decided to use BullMQ.'],
    ['Wait?', "There is no reason to wait: let's go with pnpm."],
    ['行嗎？', '沒有問題，決定用 SQLite。'],
    ['要用 Redis 嗎？', '決定不用 Redis，佇列放 SQLite。'],
    // Round 3 P3-4: a quote character inside inline code must not pair with a
    // real quote later and swallow the sentence between them.
    ['How do I quote?', 'Use `"` to quote strings. We decided to use "BullMQ".'],
    // P3
    ['Which framework?', "I'll go with Fastify here — it has the schema validation built in."],
  ])('a decision after another clause still counts: %s / %s', (u, a) => {
    expect(classifyTurn(u, a)?.kind).toBe('decision');
  });

  // Re-review P2-b: code, quotes and 決定 as an ordinary verb are not decisions.
  it.each([
    ['Show me', 'Here it is:\n```ts\n// we decided to use BullMQ\nconst q = new Queue();\n```\nThat is the file.'],
    ['What did they say?', 'The reviewer wrote: "we decided to use BullMQ" — that is not confirmed.'],
    ['他說什麼？', '他寫的是「決定用 SQLite」，但還沒確認。'],
    ['這段在做什麼？', '這段程式碼會根據 flag 決定要不要重試。'],
    // Round 3 P3-5: 決定 followed by 改/走/要用/不 is still an ordinary verb.
    ['什麼時候？', '我們決定改天再討論。'],
    ['他人呢？', '他決定走了。'],
    ['怎麼選？', '系統會決定要用哪個 provider。'],
    ['選好了嗎？', '我還決定不了。'],
  ])('no false positive on code, quotes or a plain verb: %s', (u, a) => {
    expect(classifyTurn(u, a)).toBeNull();
  });

  // Known false negative, documented rather than fixed: an inch mark
  // (12" monitor) opens a quote the stripper pairs with the next one.
  it('a recall block injected into the user text does not make every later turn a decision', () => {
    const user = '[MeMesh recall]\n- (conversation) hermes-turn-s-abc: Assistant: We decided to use BullMQ.\n\nWhat time is it?';
    expect(classifyTurn(user, 'About 3pm.')).toBeNull();
    // Even with the recall block not at the very start, user text is never classified.
    expect(classifyTurn('We decided to use BullMQ', 'Sounds good.')).toBeNull();
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
    expect(tags.length).toBeGreaterThanOrEqual(3);
    expect(tags).toEqual(expect.arrayContaining(['platform:hermes', 'session:s9', 'signal:decision']));
  });
});
