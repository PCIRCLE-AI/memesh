/**
 * A decision keeps the reason it was made and the condition it holds under.
 *
 * A decision stored as a bare conclusion — "keep the redactor as is, do not
 * extend it" — was later read as a standing ban, long after the reason for
 * it (it could not be done cleanly then) had gone. Two halves close that:
 * the writer refuses a new decision without `why`, and every briefing line
 * shows the reason (or that there is none) and how long nobody has checked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { remember, recall } from '../../src/core/operations.js';
import { importMemories } from '../../src/core/serializer.js';
import { handleTool } from '../../src/mcp/tools.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { assembleBriefing, readBriefingIndex } from '../../src/core/briefing.js';
import { buildBriefingIndex, INDEX_LINE_MAX_CHARS, type IndexCandidate } from '../../src/core/briefing-index.js';
import { toTopologyEntity, type PoolRow } from '../../src/core/briefing-pools.js';
import { DECISION_TYPES, topologyLine } from '../../src/core/work-topology.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const PROJECT = 'decision-why-fixture';
const WHY = 'PostgreSQL is too heavy to deploy for one user; revisit if we add a hosted tier';
const DAY = 86_400_000;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-decision-why-'));
  openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  removeTempDir(tmpDir);
});

const observationsOf = (name: string) => (getDatabase()
  .prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id')
  .all(name) as Array<{ content: string }>).map((r) => r.content);

describe('remember refuses a decision without its reason', () => {
  it('refuses a new decision with no why, naming both halves, and stores nothing', () => {
    expect(() => remember({ name: 'db-choice', type: 'decision', observations: ['Use SQLite'] }))
      .toThrow(/needs `why`.*reason for it and what would make it stop holding/);
    expect(getDatabase().prepare('SELECT 1 FROM entities WHERE name = ?').get('db-choice')).toBeUndefined();
  });

  it('stores why as the observation "Why: …"', () => {
    remember({ name: 'db-choice', type: 'decision', observations: ['Use SQLite'], why: WHY });
    expect(observationsOf('db-choice')).toEqual(['Use SQLite', `Why: ${WHY}`]);
  });

  it('accepts an observation that already starts with "Why: " instead of the field', () => {
    remember({ name: 'db-choice', type: 'decision', observations: ['Use SQLite', `Why: ${WHY}`] });
    expect(observationsOf('db-choice')).toContain(`Why: ${WHY}`);
  });

  it('covers architecture_decision and design_decision too', () => {
    for (const type of ['architecture_decision', 'design_decision']) {
      expect(() => remember({ name: `x-${type}`, type, observations: ['x'] }), type).toThrow(/needs `why`/);
    }
  });

  it('does not ask for it again when adding to a decision that exists', () => {
    remember({ name: 'db-choice', type: 'decision', observations: ['Use SQLite'], why: WHY });
    remember({ name: 'db-choice', type: 'decision', observations: ['WAL mode on'] });
    expect(observationsOf('db-choice')).toEqual(['Use SQLite', `Why: ${WHY}`, 'WAL mode on']);
  });

  it('asks for it on a replace, which rewrites the decision', () => {
    remember({ name: 'db-choice', type: 'decision', observations: ['Use SQLite'], why: WHY });
    expect(() => remember({ name: 'db-choice', replace: true, observations: ['Use DuckDB'] })).toThrow(/needs `why`/);
    expect(observationsOf('db-choice')).toEqual(['Use SQLite', `Why: ${WHY}`]);
    remember({ name: 'db-choice', replace: true, observations: ['Use DuckDB'], why: 'analytics queries; revisit if writes dominate' });
    expect(observationsOf('db-choice')).toEqual(['Use DuckDB', 'Why: analytics queries; revisit if writes dominate']);
  });

  it('asks for it when replace reclassifies a note as a decision', () => {
    remember({ name: 'n', type: 'note', observations: ['x'] });
    expect(() => remember({ name: 'n', type: 'decision', replace: true, observations: ['x'] })).toThrow(/needs `why`/);
  });

  it('works with the note form', () => {
    remember({ note: 'SQLite for local-first storage', type: 'decision', why: WHY });
    const row = getDatabase().prepare("SELECT name FROM entities WHERE type = 'decision'").get() as { name: string };
    expect(observationsOf(row.name)).toContain(`Why: ${WHY}`);
  });

  it('redacts a credential in why like any other observation', () => {
    remember({ name: 'db-choice', type: 'decision', observations: ['x'], why: 'the old url postgres://u:hunter2hunter2@db/x leaked; holds while we self-host' });
    expect(observationsOf('db-choice').join('\n')).not.toContain('hunter2hunter2');
  });

  it('never drops a memory from an untrusted writer for it', () => {
    remember({ name: 'from-note-file', type: 'decision', observations: ['x'], trustOverride: 'untrusted' });
    expect(observationsOf('from-note-file')).toEqual(['x']);
  });

  it('an import of a decision with no reason is stored, not refused', () => {
    const result = importMemories({
      data: { version: '1', exported_at: '2026-10-01T00:00:00Z', entity_count: 1, entities: [{ name: 'imported-choice', type: 'decision', observations: ['Use SQLite'], tags: [] }], relations: [] },
      merge_strategy: 'skip',
    } as unknown as Parameters<typeof importMemories>[0]);
    expect(result.imported).toBe(1);
    expect(observationsOf('imported-choice')).toEqual(['Use SQLite']);
  });

  it('the MCP tool refuses it with the same sentence and stores it with why', async () => {
    const refused = await handleTool('remember', { name: 'mcp-choice', type: 'decision', observations: ['x'], project: false });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toMatch(/needs `why`/);
    const ok = await handleTool('remember', { name: 'mcp-choice', type: 'decision', observations: ['x'], why: WHY, project: false });
    expect(ok.isError).toBeFalsy();
    expect(observationsOf('mcp-choice')).toContain(`Why: ${WHY}`);
  });
});

describe('the briefing line shows the reason and the age', () => {
  const NOW = Date.parse('2026-10-06T00:00:00Z');
  const row = (o: Partial<PoolRow>): PoolRow => ({ id: 7, name: 'd', type: 'decision', title: 'Keep the redactor as is', metadata: null, ...o } as PoolRow);
  const line = (r: PoolRow, why: string | null) => topologyLine(toTopologyEntity(r, new Map([[r.id, { first: 'x', fix: null, why }]]), NOW), 400);

  it('shows the latest Why after the title', () => {
    expect(line(row({ recency: '2026-10-05 00:00:00' }), 'removing it stores keys in clear; revisit when extending is clean'))
      .toBe('- [decision] Keep the redactor as is — Why: removing it stores keys in clear; revisit when extending is clean [mem:7]');
  });

  it('says so when there is no reason', () => {
    expect(line(row({ recency: '2026-10-05 00:00:00' }), null)).toBe('- [decision] Keep the redactor as is (no reason recorded) [mem:7]');
  });

  it('asks for a re-check after 30 days nobody read or added to it', () => {
    const r = row({ recency: '2026-08-01 00:00:00', last_accessed_at: undefined });
    expect(line(r, 'a reason')).toBe('- [decision] Keep the redactor as is — Why: a reason (unconfirmed 66 days: re-check before relying) [mem:7]');
  });

  it('a recent read clears the age note, an older one does not', () => {
    expect(line(row({ recency: '2026-08-01 00:00:00', last_accessed_at: new Date(NOW - 2 * DAY).toISOString() }), 'r')).not.toContain('unconfirmed');
    expect(line(row({ recency: '2026-08-01 00:00:00', last_accessed_at: new Date(NOW - 40 * DAY).toISOString() }), 'r')).toContain('(unconfirmed 40 days');
  });

  it('keeps both notes and the handle when the line is cut', () => {
    const long = line(row({ title: 'x'.repeat(500), recency: '2026-08-01 00:00:00' }), null);
    // The budget is the text's; the prefix and clip's trailing ellipsis sit outside it, as on every line.
    expect(long.length).toBeLessThanOrEqual(400 + '- [decision] '.length + 1);
    expect(long).toMatch(/\(no reason recorded\) \(unconfirmed 66 days: re-check before relying\) \[mem:7\]$/);
  });

  it('leaves other types and the dashboard rows alone', () => {
    const lesson = toTopologyEntity(row({ type: 'pattern', recency: '2026-08-01 00:00:00' }), new Map([[7, { first: 'x', fix: null, why: 'r' }]]), NOW);
    expect(topologyLine(lesson, 400)).toBe('- [pattern] Keep the redactor as is [mem:7]');
    expect(topologyLine({ name: 'd', type: 'decision', id: 7, title: 'Keep the redactor as is' }, 400)).toBe('- [decision] Keep the redactor as is [mem:7]');
  });

  it('end to end: the briefing shows it, and a recall clears the age note', () => {
    remember({ name: 'keep-redactor', type: 'decision', title: 'Keep the redactor as is', observations: ['x'], why: 'removing it stores keys in clear; revisit when extending is clean', tags: [`project:${PROJECT}`] });
    new KnowledgeGraph(getDatabase()).createEntity('bare-choice', 'decision', { observations: ['Use tabs'], tags: [`project:${PROJECT}`], trustOverride: 'trusted', title: 'Use tabs' });
    // 40 days old, never read.
    getDatabase().prepare("UPDATE observations SET created_at = datetime('now', '-40 days')").run();
    getDatabase().prepare("UPDATE entities SET created_at = datetime('now', '-40 days'), last_accessed_at = NULL").run();
    const before = assembleBriefing(PROJECT).text;
    expect(before).toMatch(/Keep the redactor as is — Why: removing it stores keys in clear; revisit when extending is clean \(unconfirmed 40 days: re-check before relying\) \[mem:\d+\]/);
    expect(before).toMatch(/Use tabs \(no reason recorded\) \(unconfirmed 40 days: re-check before relying\) \[mem:\d+\]/);
    recall({ query: 'redactor', tag: `project:${PROJECT}` });
    const after = assembleBriefing(PROJECT).text;
    expect(after).toMatch(/Keep the redactor as is — Why: removing it stores keys in clear; revisit when extending is clean \[mem:\d+\]/);
    expect(after).toContain('Use tabs (no reason recorded) (unconfirmed 40 days');
  });
});

// ── Everything below: the same marks on every surface and every decision type ──

/** SQLite UTC text for an epoch, as the database writes it. */
const sqliteAt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** Make every memory in the throwaway database `days` old and never read. */
function backdate(days: number): void {
  getDatabase().prepare(`UPDATE observations SET created_at = datetime('now', '-${days} days')`).run();
  getDatabase().prepare(`UPDATE entities SET created_at = datetime('now', '-${days} days'), last_accessed_at = NULL`).run();
}
const idOf = (name: string) => (getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
/** The line carrying `[mem:<id>]` among `lines`; fails the test when there is none. */
function lineOf(lines: readonly string[], name: string): string {
  const found = lines.find((l) => l.endsWith(`[mem:${idOf(name)}]`));
  if (!found) throw new Error(`no line for ${name} in:\n${lines.join('\n')}`);
  return found;
}
/** The ranked block of a briefing: everything before the index heading. */
const rankedLines = (text: string): string[] => text.split('Index of durable memories for')[0].split('\n');
const NOW = Date.parse('2026-10-06T00:00:00Z');
const candidate = (o: Partial<IndexCandidate>): IndexCandidate => ({
  id: 7, type: 'decision', title: 'Keep the redactor as is', snippet: 'Keep the redactor as is, do not extend it',
  lastActivity: sqliteAt(NOW - DAY), metadata: null, ...o,
});
const indexLines = (c: IndexCandidate) => buildBriefingIndex([c], PROJECT, NOW).lines.filter((l) => l.startsWith('- ['));

describe('the durable-memory index marks decisions like the briefing does', () => {
  it('shows the reason, says when there is none, and asks for a re-check after 30 days', () => {
    const reason = 'removing it stores keys in clear; revisit when extending is clean';
    expect(indexLines(candidate({ why: reason, recency: sqliteAt(NOW - DAY) })))
      .toEqual([`- [decision] Keep the redactor as is — Why: ${reason} [mem:7]`]);
    expect(indexLines(candidate({ why: null, recency: sqliteAt(NOW - DAY) })))
      .toEqual(['- [decision] Keep the redactor as is (no reason recorded) [mem:7]']);
    // The index keeps its own 120-character cap; the marks are never cut, so the reason is what yields.
    const [old] = indexLines(candidate({ why: reason, recency: sqliteAt(NOW - 40 * DAY), lastActivity: sqliteAt(NOW - 40 * DAY) }));
    expect(old).toMatch(/^- \[decision\] Keep the redactor as is — Why: removing it.*\(unconfirmed 40 days: re-check before relying\) \[mem:7\]$/);
  });

  it('a read inside the window clears the age note, as in the ranked block', () => {
    const old = sqliteAt(NOW - 40 * DAY);
    const read = new Date(NOW - 2 * DAY).toISOString();
    expect(indexLines(candidate({ why: 'r', recency: old, lastActivity: old, lastAccessedAt: read })).join('')).not.toContain('unconfirmed');
    expect(indexLines(candidate({ why: 'r', recency: old, lastActivity: old, lastAccessedAt: null })).join('')).toContain('unconfirmed 40 days');
  });

  it('leaves other types, and a decision whose reason was not read, unchanged', () => {
    expect(indexLines(candidate({ type: 'pattern', why: 'r', recency: sqliteAt(NOW - 40 * DAY) })))
      .toEqual(['- [pattern] Keep the redactor as is [mem:7]']);
    expect(indexLines(candidate({ recency: sqliteAt(NOW - 40 * DAY) })))
      .toEqual(['- [decision] Keep the redactor as is [mem:7]']);
  });

  it('keeps the handle and both notes when the index line is cut, and the reason over the title', () => {
    const [line] = indexLines(candidate({
      title: 'Keep the redactor exactly as it is today and do not extend it to cover any new credential shape',
      snippet: null,
      why: 'extending it blocks the release; revisit once the redactor is table driven',
      recency: sqliteAt(NOW - 40 * DAY),
      lastActivity: sqliteAt(NOW - 40 * DAY),
    }));
    expect(line).toMatch(/ \(unconfirmed 40 days: re-check before relying\) \[mem:7\]$/);
    // The reason is not reduced to a stub: at least a dozen of its own characters survive.
    expect(line.match(/Why: (\S.*?)(?:…)? \(unconfirmed/)?.[1].length ?? 0).toBeGreaterThanOrEqual(12);
    expect(line.length).toBeLessThanOrEqual(INDEX_LINE_MAX_CHARS + '- [decision] '.length + 1);
  });

  for (const type of [...DECISION_TYPES]) {
    it(`end to end, a ${type}: reason, no reason and the age note on the index and the briefing; a recall clears both`, () => {
      remember({ name: 'with-reason', type, title: 'Keep the cache layer', observations: ['Keep the cache layer'], why: 'the API is rate limited; revisit if the vendor lifts the limit', tags: [`project:${PROJECT}`] });
      new KnowledgeGraph(getDatabase()).createEntity('no-reason', type, { observations: ['Use tabs'], tags: [`project:${PROJECT}`], trustOverride: 'trusted', title: 'Use tabs' });
      const fresh = readBriefingIndex(getDatabase(), PROJECT).lines;
      expect(lineOf(fresh, 'with-reason')).toContain('Why: the API is rate limited; revisit if the vendor lifts the limit');
      expect(lineOf(fresh, 'no-reason')).toContain('(no reason recorded)');
      expect(fresh.join('\n')).not.toContain('unconfirmed');

      backdate(40);
      const index = readBriefingIndex(getDatabase(), PROJECT).lines;
      const ranked = rankedLines(assembleBriefing(PROJECT).text);
      // The ranked line has room for the whole reason; the index's 120 characters, once the age note is paid, do not.
      expect(lineOf(ranked, 'with-reason')).toMatch(/Why: the API is rate limited; revisit if the vendor lifts the limit \(unconfirmed 40 days: re-check before relying\) \[mem:\d+\]$/);
      expect(lineOf(index, 'with-reason')).toMatch(/Why: the API is.*\(unconfirmed 40 days: re-check before relying\) \[mem:\d+\]$/);
      for (const lines of [index, ranked]) {
        expect(lineOf(lines, 'no-reason')).toMatch(/\(no reason recorded\) \(unconfirmed 40 days: re-check before relying\) \[mem:\d+\]$/);
      }

      recall({ query: 'cache', tag: `project:${PROJECT}` });
      recall({ query: 'tabs', tag: `project:${PROJECT}` });
      for (const lines of [readBriefingIndex(getDatabase(), PROJECT).lines, rankedLines(assembleBriefing(PROJECT).text)]) {
        expect(lineOf(lines, 'with-reason')).not.toContain('unconfirmed');
        expect(lineOf(lines, 'no-reason')).not.toContain('unconfirmed');
      }
    });
  }
});

describe('a decision line that must be cut keeps the condition, not the title', () => {
  const entity = (o: { title?: string | null; why: string | null; unconfirmedDays?: number | null }) => ({
    name: 'd', type: 'decision', id: 7, title: o.title ?? null, why: o.why, unconfirmedDays: o.unconfirmedDays ?? null,
  });
  const TITLE = 'Use exponential backoff with jitter for every outbound HTTP call in every service we operate today and tomorrow';

  it('clips the title first and shows the whole reason', () => {
    const why = 'the vendor bans bursts; revisit if the vendor moves to a token bucket';
    const line = topologyLine(entity({ title: TITLE, why }), 160);
    expect(line).toContain(`Why: ${why} [mem:7]`);
    expect(line).toMatch(/^- \[decision\] Use exponential backoff.*… — Why: /);
    expect(line.length).toBeLessThanOrEqual(160 + '- [decision] '.length + 1);
  });

  it('stops clipping the title at its floor and clips the reason after that', () => {
    const why = `the vendor bans bursts ${'and punishes every retry storm '.repeat(8)}; revisit if the vendor changes its limits`;
    const line = topologyLine(entity({ title: TITLE, why, unconfirmedDays: 41 }), 160);
    const [head] = line.replace('- [decision] ', '').split(' — Why: ');
    expect(head.length).toBeGreaterThanOrEqual(40);
    expect(head.length).toBeLessThanOrEqual(41);
    expect(line).toContain(' — Why: the vendor bans bursts');
    expect(line).toMatch(/… \(unconfirmed 41 days: re-check before relying\) \[mem:7\]$/);
  });

  it('leaves a line that fits as it was', () => {
    expect(topologyLine(entity({ title: 'Short title', why: 'short reason' }), 160)).toBe('- [decision] Short title — Why: short reason [mem:7]');
  });
});

describe('a decision whose only observation is its reason shows the reason once', () => {
  const only = (line: string) => expect(line.match(/Why: /g)).toHaveLength(1);

  it('ranked block and index, with no title', () => {
    remember({ name: 'only-why', type: 'decision', why: 'the cache is the one thing that scales; revisit if it stops', tags: [`project:${PROJECT}`] });
    expect(observationsOf('only-why')).toEqual(['Why: the cache is the one thing that scales; revisit if it stops']);
    const ranked = lineOf(rankedLines(assembleBriefing(PROJECT).text), 'only-why');
    const indexed = lineOf(readBriefingIndex(getDatabase(), PROJECT).lines, 'only-why');
    for (const line of [ranked, indexed]) {
      only(line);
      expect(line).toBe(`- [decision] Why: the cache is the one thing that scales; revisit if it stops [mem:${idOf('only-why')}]`);
    }
  });

  it('with a title, the title leads and the reason follows once', () => {
    remember({ name: 'titled-only-why', type: 'decision', title: 'Cache everything', why: 'it is the one thing that scales; revisit if it stops', tags: [`project:${PROJECT}`] });
    const ranked = lineOf(rankedLines(assembleBriefing(PROJECT).text), 'titled-only-why');
    const indexed = lineOf(readBriefingIndex(getDatabase(), PROJECT).lines, 'titled-only-why');
    for (const line of [ranked, indexed]) {
      only(line);
      expect(line).toContain('Cache everything — Why: it is the one thing that scales; revisit if it stops');
    }
  });
});

describe('the reason argument', () => {
  it('stores one label, even when the caller typed it', () => {
    remember({ name: 'labelled', type: 'decision', observations: ['x'], why: 'Why: because; revisit if it changes' });
    expect(observationsOf('labelled')).toEqual(['x', 'Why: because; revisit if it changes']);
  });

  it('a label with nothing after it is no reason at all', () => {
    expect(() => remember({ name: 'label-only', type: 'decision', observations: ['x'], why: 'Why: ' })).toThrow(/needs `why`/);
  });

  it('the refusal names the type with the right article', () => {
    const refusal = (type: string) => { try { remember({ name: `n-${type}`, type, observations: ['x'] }); } catch (e) { return (e as Error).message; } return ''; };
    expect(refusal('decision')).toContain('this decision: a decision needs `why`');
    expect(refusal('architecture_decision')).toContain('this architecture_decision: an architecture_decision needs `why`');
    expect(refusal('design_decision')).toContain('this design_decision: a design_decision needs `why`');
  });
});

describe('the 30-day line is exact', () => {
  const MINUTE = 60_000;
  const snippets = (added: string | null) => new Map([[7, { first: 'x', fix: null, why: 'r', lastAddedAt: added }]]);
  const rankedAt = (ms: number) => topologyLine(toTopologyEntity({ id: 7, name: 'd', type: 'architecture_decision', title: 'T', metadata: null }, snippets(sqliteAt(ms)), NOW), 400);

  it('exactly 30 days is marked; 29 days 23:59 is not (ranked block, whatever the type)', () => {
    expect(rankedAt(NOW - 30 * DAY)).toContain('(unconfirmed 30 days: re-check before relying)');
    expect(rankedAt(NOW - 30 * DAY + MINUTE)).not.toContain('unconfirmed');
    expect(rankedAt(NOW - 30 * DAY - MINUTE)).toContain('(unconfirmed 30 days');
  });

  it('exactly 30 days is marked; 29 days 23:59 is not (index)', () => {
    const at = (ms: number) => indexLines(candidate({ why: 'r', recency: sqliteAt(ms), lastActivity: sqliteAt(ms) })).join('');
    expect(at(NOW - 30 * DAY)).toContain('(unconfirmed 30 days: re-check before relying)');
    expect(at(NOW - 30 * DAY + MINUTE)).not.toContain('unconfirmed');
  });

  it('a read counts the same way', () => {
    const readAt = (ms: number) => topologyLine(toTopologyEntity({ id: 7, name: 'd', type: 'decision', title: 'T', metadata: null, last_accessed_at: sqliteAt(ms) }, snippets(sqliteAt(NOW - 90 * DAY)), NOW), 400);
    expect(readAt(NOW - 30 * DAY)).toContain('unconfirmed 30 days');
    expect(readAt(NOW - 30 * DAY + MINUTE)).not.toContain('unconfirmed');
  });
});

describe('the latest reason, and the same age on both readers', () => {
  it('an older Why as the first observation is not printed beside the newer one', () => {
    remember({ name: 'two-whys', type: 'decision', observations: ['Why: the old reason; revisit if x'], why: 'the new reason; revisit if y', tags: [`project:${PROJECT}`] });
    for (const lines of [rankedLines(assembleBriefing(PROJECT).text), readBriefingIndex(getDatabase(), PROJECT).lines]) {
      const line = lineOf(lines, 'two-whys');
      expect(line).toBe(`- [decision] Why: the new reason; revisit if y [mem:${idOf('two-whys')}]`);
    }
  });

  it('a read stamped in the future does not hide the age note', () => {
    remember({ name: 'future-read', type: 'decision', title: 'Keep it', observations: ['Keep it'], why: 'a reason; revisit if x', tags: [`project:${PROJECT}`] });
    backdate(40);
    getDatabase().prepare("UPDATE entities SET last_accessed_at = '2099-01-01 00:00:00'").run();
    for (const lines of [rankedLines(assembleBriefing(PROJECT).text), readBriefingIndex(getDatabase(), PROJECT).lines]) {
      expect(lineOf(lines, 'future-read')).toContain('(unconfirmed 40 days: re-check before relying)');
    }
  });

  it('a decision with no observation at all is marked the same way in the ranked block and the index', () => {
    const id = Number(getDatabase().prepare("INSERT INTO entities (name, type, title, created_at) VALUES ('bare-arch', 'architecture_decision', 'Bare', datetime('now', '-40 days'))").run().lastInsertRowid);
    getDatabase().prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, `project:${PROJECT}`);
    for (const lines of [rankedLines(assembleBriefing(PROJECT).text), readBriefingIndex(getDatabase(), PROJECT).lines]) {
      expect(lineOf(lines, 'bare-arch')).toBe(`- [architecture_decision] Bare (no reason recorded) (unconfirmed 40 days: re-check before relying) [mem:${id}]`);
    }
  });
});

describe('a date in the future never counts as a confirmation', () => {
  it('an observation stamped years ahead does not hide the age note (any decision type)', () => {
    remember({ name: 'future-dated', type: 'architecture_decision', title: 'Queue it', observations: ['Queue it'], why: 'buffers bursts; revisit if flat', tags: [`project:${PROJECT}`] });
    backdate(40);
    getDatabase().prepare("INSERT INTO observations (entity_id, content, created_at) VALUES (?, 'added by a clock gone wrong', '2099-01-01 00:00:00')").run(idOf('future-dated'));
    expect(lineOf(rankedLines(assembleBriefing(PROJECT).text), 'future-dated')).toContain('(unconfirmed 40 days: re-check before relying)');
    expect(lineOf(readBriefingIndex(getDatabase(), PROJECT).lines, 'future-dated')).toContain('(unconfirmed 40 days: re-check before relying)');
  });
});

describe('a key split between the title and the reason is masked as one set', () => {
  const dashes = '-'.repeat(5);
  const kind = ['RSA', 'PRIVATE', 'KEY'].join(' ');
  const header = `${dashes}BEGIN ${kind}${dashes}`;
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7';

  it('ranked line: header in the title, body in the reason', () => {
    const entity = toTopologyEntity({ id: 7, name: 'split', type: 'decision', title: header, metadata: null }, new Map([[7, { first: 'x', fix: null, why: body }]]), NOW);
    expect(JSON.stringify(entity)).not.toContain(body);
    expect(entity.why).toBe('***REDACTED***');
  });

  it('index line: header in the title, body in the reason', () => {
    const [line] = indexLines(candidate({ title: header, snippet: null, why: body, recency: sqliteAt(NOW - DAY) }));
    expect(line).not.toContain(body);
    expect(line).toContain('***REDACTED***');
  });
});
