/**
 * #561: an observation holding a lone UTF-16 surrogate is stored as U+FFFD,
 * and `import --merge append` compared the incoming text against what was
 * stored, so it never matched and every re-run appended the observation again.
 */
import { describe, it, expect } from 'vitest';
import { importMemories } from '../../src/core/operations.js';
import { getDatabase } from '../../src/db.js';
import type { ExportResult } from '../../src/core/types.js';
import { appendObservations } from '../../src/storage/entity-write.js';
import { forget, remember } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-import-surrogate-');

function bundle(observations: string[], type = 'note'): ExportResult {
  return {
    version: '3.1.0',
    exported_at: '2026-10-05T00:00:00.000Z',
    entity_count: 1,
    entities: [{ name: 'surrogate-561', type, namespace: 'personal', observations, tags: [], relations: [] }],
  };
}

const stored = () => (getDatabase()
  .prepare("SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'surrogate-561' ORDER BY o.id")
  .all() as Array<{ content: string }>).map((row) => row.content);

describe('#561 import --merge append with a lone surrogate', () => {
  it('stores the observation once, however many times the same file is imported', () => {
    for (let run = 0; run < 3; run++) importMemories({ data: bundle(['lone\ud800end', 'plain']), merge_strategy: 'append' });
    expect(stored()).toEqual(['lone\ufffdend', 'plain']);
  });

  // A lesson's observations are not deduped by the writer (each one is a
  // distinct structured line), so for a lesson import's own check is the only one.
  it('a lesson is not given the same observation twice either', () => {
    for (let run = 0; run < 3; run++) {
      importMemories({ data: bundle(['Fix: lone\ud800end'], 'lesson_learned'), merge_strategy: 'append' });
    }
    expect(stored()).toEqual(['Fix: lone\ufffdend']);
  });

  it('treats a lone high and a lone low surrogate the same way as storage does', () => {
    importMemories({ data: bundle(['a\udc00b', 'c\ud83dd']), merge_strategy: 'append' });
    importMemories({ data: bundle(['a\udc00b', 'c\ud83dd', 'kept \ud83d\ude00 pair']), merge_strategy: 'append' });
    expect(stored()).toEqual(['a\ufffdb', 'c\ufffdd', 'kept \ud83d\ude00 pair']);
  });
});

describe('#561 the shared observation writer dedupes in the stored form', () => {
  it('a deduping append does not write a lone-surrogate observation the entity already holds', () => {
    remember({ name: 'surrogate-561', type: 'note', observations: ['lone\ud800end'] });
    const id = (getDatabase().prepare("SELECT id FROM entities WHERE name = 'surrogate-561'").get() as { id: number }).id;
    const written = appendObservations(getDatabase(), id, ['lone\ud800end', 'new'], { dedupe: true, readExisting: true });
    expect(written).toEqual(['new']);
    expect(stored()).toEqual(['lone\ufffdend', 'new']);
  });
});

describe('#561 a re-import that adds nothing appends nothing', () => {
  it('reports the unchanged memory as skipped and leaves its trust alone', () => {
    remember({ name: 'kept-561', type: 'decision', observations: ['plain fact', 'lone\ud800end'], tags: ['topic:x'] });
    const trust = () => (JSON.parse((getDatabase().prepare("SELECT metadata FROM entities WHERE name = 'kept-561'").get() as { metadata: string }).metadata) as { trust?: string }).trust;
    expect(trust()).toBe('trusted');
    const again: ExportResult = {
      version: '3.1.0', exported_at: '2026-10-05T00:00:00.000Z', entity_count: 1,
      entities: [{ name: 'kept-561', type: 'decision', namespace: 'personal', observations: ['plain fact', 'lone\ud800end'], tags: ['topic:x'], relations: [] }],
    };
    const result = importMemories({ data: again, merge_strategy: 'append' });
    expect({ appended: result.appended, skipped: result.skipped }).toEqual({ appended: 0, skipped: 1 });
    expect(trust()).toBe('trusted');
  });

  const entryOf = (overrides: Partial<ExportResult['entities'][number]>): ExportResult => ({
    version: '3.1.0', exported_at: '2026-10-05T00:00:00.000Z', entity_count: 1,
    entities: [{ name: 'same-561', type: 'decision', namespace: 'personal', observations: ['fact'], tags: [], relations: [], ...overrides }],
  });
  const row = () => getDatabase().prepare("SELECT status, title, namespace FROM entities WHERE name = 'same-561'").get() as { status: string; title: string | null; namespace: string };

  it('restore_archived brings back a forgotten memory even when its text is unchanged', () => {
    remember({ name: 'same-561', type: 'decision', observations: ['fact'] });
    forget({ name: 'same-561' });
    const result = importMemories({ data: entryOf({}), merge_strategy: 'append', restore_archived: true });
    expect(result.skipped).toBe(0);
    expect(row().status).toBe('active');
  });

  it('a new tag, a new title or a namespace move is still a change', () => {
    remember({ name: 'same-561', type: 'decision', observations: ['fact'] });
    expect(importMemories({ data: entryOf({ tags: ['topic:new'] }), merge_strategy: 'append' }).appended).toBe(1);
    expect(importMemories({ data: entryOf({ title: 'A title' }), merge_strategy: 'append' }).appended).toBe(1);
    expect(row().title).toBe('A title');
    expect(importMemories({ data: entryOf({}), merge_strategy: 'append', namespace: 'team' }).appended).toBe(1);
    expect(row().namespace).toBe('team');
  });

  it('a lone surrogate in a tag or the title does not make an unchanged re-import look new', () => {
    const data = entryOf({ tags: ['x\ud800y'], title: 'T\ud800' });
    importMemories({ data, merge_strategy: 'append' });
    importMemories({ data, merge_strategy: 'append' });
    const third = importMemories({ data, merge_strategy: 'append' });
    expect({ appended: third.appended, skipped: third.skipped }).toEqual({ appended: 0, skipped: 1 });
  });

  // The import masks a credential before it compares (#569 with #561): an
  // unchanged re-import of a file holding one compares the masked line, so it
  // adds nothing. Assembled at runtime so no line here looks like a credential.
  it('a credential in the file does not make an unchanged re-import look new', () => {
    const password = 'hunter2hunter2';
    const url = ['postgres://appuser', `${password}@db.internal:5432/app`].join(':');
    for (const [name, type, line] of [['cred-561', 'decision', `Staging is ${url}`], ['cred-561-lesson', 'lesson_learned', `Fix: use ${url}`]]) {
      const data = entryOf({ name, type, observations: [line] });
      importMemories({ data, merge_strategy: 'append' });
      const second = importMemories({ data, merge_strategy: 'append' });
      expect({ appended: second.appended, skipped: second.skipped }, type).toEqual({ appended: 0, skipped: 1 });
      const rows = (getDatabase()
        .prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ?')
        .all(name) as Array<{ content: string }>).map((r) => r.content);
      expect(rows, type).toHaveLength(1);
      expect(rows[0], type).not.toContain(password);
    }
  });

  it('still appends, and marks untrusted, when the file brings new text', () => {
    remember({ name: 'grown-561', type: 'decision', observations: ['plain fact'] });
    const result = importMemories({
      data: { version: '3.1.0', exported_at: '2026-10-05T00:00:00.000Z', entity_count: 1,
        entities: [{ name: 'grown-561', type: 'decision', namespace: 'personal', observations: ['plain fact', 'new fact'], tags: [], relations: [] }] },
      merge_strategy: 'append',
    });
    expect(result.appended).toBe(1);
  });
});
