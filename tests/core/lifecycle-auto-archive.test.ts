import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import {
  archiveUnusedAutoCaptured,
  readLastAutoArchiveRun,
  AUTO_ARCHIVE_AT_KEY,
  AUTO_ARCHIVE_UNUSED_DAYS,
} from '../../src/core/lifecycle.js';
import { AUTO_CAPTURE_TAG } from '../../src/core/types.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-auto-archive-');

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

interface Row {
  name: string;
  type: string;
  auto?: boolean;
  createdDaysAgo?: number;
  recallHits?: number;
  accessedDaysAgo?: number;
  observedDaysAgo?: number;
}

/** One row straight into the tables, so ages and counters can be anything. */
function put({ name, type, auto = true, createdDaysAgo = 30, recallHits = 0, accessedDaysAgo, observedDaysAgo }: Row): number {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);
  const id = kg.createEntity(name, type, {
    title: `title of ${name}`,
    observations: [`observation of ${name} about zebrafish migration`],
    tags: auto ? [AUTO_CAPTURE_TAG, 'project:p'] : ['project:p'],
    trustOverride: 'untrusted',
  });
  db.prepare('UPDATE entities SET created_at = ?, recall_hits = ?, last_accessed_at = ? WHERE id = ?')
    .run(daysAgo(createdDaysAgo), recallHits, accessedDaysAgo === undefined ? null : daysAgo(accessedDaysAgo), id);
  db.prepare('UPDATE observations SET created_at = ? WHERE entity_id = ?').run(daysAgo(observedDaysAgo ?? createdDaysAgo), id);
  return id;
}

const statusOf = (name: string) => (getDatabase().prepare('SELECT status FROM entities WHERE name = ?').get(name) as { status: string }).status;
const searchable = (term: string) => (getDatabase().prepare('SELECT COUNT(*) AS c FROM entities_fts WHERE entities_fts MATCH ?').get(term) as { c: number }).c;
const forceDue = () => getDatabase().prepare('DELETE FROM memesh_metadata WHERE key = ?').run(AUTO_ARCHIVE_AT_KEY);

describe('Feature: unused auto-captured memories are archived, and nothing else', () => {
  it('archives old unused auto-captured commits and session rollups, and says what it did', () => {
    put({ name: 'commit-old', type: 'commit' });
    put({ name: 'insight-old', type: 'session-insight' });
    put({ name: 'summary-old', type: 'session-summary' });
    forceDue();

    const run = archiveUnusedAutoCaptured(getDatabase())!;
    expect(run.archived).toBe(3);
    expect(run.byType).toEqual({ commit: 1, 'session-insight': 1, 'session-summary': 1 });
    expect(run.unusedDays).toBe(AUTO_ARCHIVE_UNUSED_DAYS);
    for (const name of ['commit-old', 'insight-old', 'summary-old']) expect(statusOf(name)).toBe('archived');
    // Out of the keyword index, so a search no longer returns them.
    expect(searchable('zebrafish')).toBe(0);
    expect(run.ids.length).toBeGreaterThan(0);
    // The last run is on record, the way `memesh doctor` reads it.
    expect(readLastAutoArchiveRun(getDatabase())).toMatchObject({ archived: 3, ids: run.ids });
  });

  it('keeps what was cited, recalled in the window, recently added to, or recent', () => {
    put({ name: 'cited', type: 'commit', recallHits: 2 });
    put({ name: 'recalled', type: 'commit', accessedDaysAgo: 3 });
    put({ name: 'added-to', type: 'session-insight', createdDaysAgo: 60, observedDaysAgo: 2 });
    put({ name: 'recent', type: 'commit', createdDaysAgo: 5 });
    put({ name: 'long-ago-recall', type: 'commit', accessedDaysAgo: 40 });
    forceDue();

    const run = archiveUnusedAutoCaptured(getDatabase())!;
    expect(run.archived).toBe(1);
    expect(run.keptCited).toBe(1);
    expect(statusOf('long-ago-recall')).toBe('archived');
    for (const name of ['cited', 'recalled', 'added-to', 'recent']) expect(statusOf(name), name).toBe('active');
  });

  it('never touches what an agent wrote: decisions, lessons, and a commit without the capture tag', () => {
    put({ name: 'decision-old', type: 'decision', auto: false, createdDaysAgo: 400 });
    put({ name: 'lesson-old', type: 'lesson_learned', auto: false, createdDaysAgo: 400 });
    put({ name: 'explicit-commit', type: 'commit', auto: false, createdDaysAgo: 400 });
    // Even an auto-tagged row of another type is outside the rule.
    put({ name: 'auto-lesson', type: 'lesson_learned', auto: true, createdDaysAgo: 400 });
    put({ name: 'auto-decision', type: 'decision', auto: true, createdDaysAgo: 400 });
    forceDue();

    const run = archiveUnusedAutoCaptured(getDatabase())!;
    expect(run.archived).toBe(0);
    expect(getDatabase().prepare("SELECT COUNT(*) AS c FROM entities WHERE status = 'active'").get()).toEqual({ c: 5 });
    for (const name of ['decision-old', 'lesson-old', 'explicit-commit', 'auto-lesson', 'auto-decision']) {
      expect(statusOf(name), name).toBe('active');
    }
  });

  it('is recoverable: the row and its text stay, and remembering the same name brings it back searchable', () => {
    const id = put({ name: 'commit-recover', type: 'commit' });
    forceDue();
    archiveUnusedAutoCaptured(getDatabase());
    expect(statusOf('commit-recover')).toBe('archived');

    const db = getDatabase();
    const kept = db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(id) as Array<{ content: string }>;
    expect(kept.map((o) => o.content).join(' ')).toContain('zebrafish');
    const meta = JSON.parse((db.prepare('SELECT metadata FROM entities WHERE id = ?').get(id) as { metadata: string }).metadata);
    expect(meta.auto_archive).toMatchObject({ rule: 'unused', days: AUTO_ARCHIVE_UNUSED_DAYS });
    // Readable on request.
    const archived = new KnowledgeGraph(db).search('zebrafish', { includeArchived: true });
    expect(archived.map((e) => e.name)).toContain('commit-recover');

    // Brought back by writing the same name again.
    new KnowledgeGraph(db).createEntity('commit-recover', 'commit', { observations: ['seen again about zebrafish migration'], trustOverride: 'untrusted' });
    expect(statusOf('commit-recover')).toBe('active');
    expect(searchable('zebrafish')).toBe(1);
  });

  it('runs at most once a day, and a run that archived nothing is still on record', () => {
    forceDue();
    const first = archiveUnusedAutoCaptured(getDatabase())!;
    expect(first.archived).toBe(0);
    expect(readLastAutoArchiveRun(getDatabase())).toMatchObject({ archived: 0 });
    put({ name: 'commit-after', type: 'commit' });
    expect(archiveUnusedAutoCaptured(getDatabase())).toBeNull();
    expect(statusOf('commit-after')).toBe('active');
  });

  it('leaves a row whose metadata is not JSON archived without failing the run', () => {
    const id = put({ name: 'bad-meta', type: 'commit' });
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE id = ?').run('{not json', id);
    forceDue();
    expect(archiveUnusedAutoCaptured(getDatabase())!.archived).toBe(1);
    expect(statusOf('bad-meta')).toBe('archived');
  });
});
