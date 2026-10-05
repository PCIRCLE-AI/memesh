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
import { remember } from '../../src/core/operations.js';
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
