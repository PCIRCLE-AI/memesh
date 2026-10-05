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
import { assembleBriefing } from '../../src/core/briefing.js';
import { toTopologyEntity, type PoolRow } from '../../src/core/briefing-pools.js';
import { topologyLine } from '../../src/core/work-topology.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const PROJECT = 'decision-why-fixture';
const WHY = 'PostgreSQL is too heavy to deploy for one user; revisit if we add a hosted tier';

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
  const DAY = 86_400_000;
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
