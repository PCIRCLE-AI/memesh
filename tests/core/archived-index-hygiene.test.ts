// =============================================================================
// An archived entity is absent from the FTS search index — D12
// =============================================================================
//
// Found by querying the maintainer's real graph, not by reading a diff.
// At 2136 entities (820 active, 1316 archived):
//
//   213 archived entities were still in `entities_fts`. `MATCH 'ae83279'`
//       returned the archived `commit-ae83279`.
//
// `archiveEntity` always dropped the row. `compressWeeklyNoise`, proposal
// application and `splitFusedLessons` archived with a bare status UPDATE and
// did not — and that defect fed a second:
// re-remembered entity that still had an FTS row got a SECOND document at the
// same rowid, because `createEntityInner` skipped the contentless delete for
// anything `wasArchived` on the reasoning that archiving had already removed
// it. Only one of the four archive paths had.

import { describe, it, expect, vi } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { compressWeeklyNoise } from '../../src/core/lifecycle.js';
import { indexedObservationText, insertFtsRow, removeFromFts } from '../../src/storage/fts-index.js';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const fixture = useTestDatabase('memesh-archived-index-');

/** Rows the keyword index holds for an entity id. Contentless FTS5 hides its
 *  columns but not its rowids, so this counts DOCUMENTS, which is the unit the
 *  double-insert defect duplicates. */
function ftsRowCount(db: ReturnType<typeof getDatabase>, id: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM entities_fts WHERE rowid = ?').get(id) as { c: number }
  ).c;
}

describe('compressWeeklyNoise removes archived entities from FTS (D12)', () => {
  function seedOldNoise(db: ReturnType<typeof getDatabase>, count: number): void {
    const date = new Date(Date.now() - 2 * 7 * 24 * 60 * 60 * 1000).toISOString();
    const kg = new KnowledgeGraph(db);
    for (let i = 0; i < count; i++) {
      // Through KnowledgeGraph so the entity is indexed exactly as the product
      // indexes it — a hand-rolled INSERT would leave no FTS row and the test
      // would pass without ever exercising the delete.
      kg.createEntity(`commit-noise-${i}`, 'commit', {
        observations: [`unmistakabletoken${i} touched the parser`],
        tags: ['project:test'],
      });
      db.prepare('UPDATE entities SET created_at = ? WHERE name = ?').run(
        date,
        `commit-noise-${i}`,
      );
    }
  }

  it('removes the FTS row, so keyword search stops answering with it', () => {
    const db = getDatabase();
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_noise_compress_at'");
    seedOldNoise(db, 25);

    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('commit-noise-0') as {
      id: number;
    }).id;
    expect(ftsRowCount(db, id)).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM entities_fts WHERE entities_fts MATCH 'unmistakabletoken0'").get(),
    ).toEqual({ c: 1 });

    const result = compressWeeklyNoise(db);
    expect(result.compressed).toBe(25);

    expect(
      (db.prepare('SELECT status FROM entities WHERE id = ?').get(id) as { status: string }).status,
    ).toBe('archived');
    expect(ftsRowCount(db, id)).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM entities_fts WHERE entities_fts MATCH 'unmistakabletoken0'").get(),
    ).toEqual({ c: 0 });
  });

  it('leaves the entities that stayed active fully indexed', () => {
    // The repair and the fix must remove archived rows and nothing else.
    const db = getDatabase();
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_noise_compress_at'");
    seedOldNoise(db, 25);
    const kg = new KnowledgeGraph(db);
    kg.createEntity('decision-keep-me', 'decision', {
      observations: ['survivortoken chose SQLite over Postgres'],
      tags: ['project:test'],
    });

    compressWeeklyNoise(db);

    const keep = (db.prepare('SELECT id FROM entities WHERE name = ?').get('decision-keep-me') as {
      id: number;
    }).id;
    expect(ftsRowCount(db, keep)).toBe(1);
    // Exactly one, not "contains": the compression must neither drop the
    // active entity from the index nor leave a second copy of it there.
    expect(kg.search('survivortoken')).toHaveLength(1);
    expect(kg.search('survivortoken').map((e) => e.name)).toEqual(['decision-keep-me']);
  });

  it('rolls back the weekly summary and every source when one FTS archive delete fails', () => {
    const db = getDatabase();
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_noise_compress_at'");
    seedOldNoise(db, 25);

    let injected = false;
    const failingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => {
          if (!injected && /INSERT INTO entities_fts \(entities_fts, rowid/.test(sql)) {
            injected = true;
            throw new Error('injected archive FTS delete failure');
          }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof db;
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        warnings.push(String(chunk));
        return true;
      });

    try {
      expect(() => compressWeeklyNoise(failingDb)).toThrow('injected archive FTS delete failure');
    } finally {
      spy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(warnings.some((warning) => warning.includes('removeFromFts'))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS c FROM entities WHERE type = 'weekly-summary'").get())
      .toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM entities WHERE type = 'commit' AND status = 'active'").get())
      .toEqual({ c: 25 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM entities_fts f
      JOIN entities e ON e.id = f.rowid
      WHERE e.type = 'commit' AND e.status = 'active'`).get()).toEqual({ c: 25 });
    expect(db.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_noise_compress_at'").get())
      .toBeUndefined();
  });

  it('selects each weekly source only after its immediate archive transaction begins', () => {
    const db = getDatabase();
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_noise_compress_at'");
    seedOldNoise(db, 25);
    const originalTransaction = db.transaction.bind(db);
    let injected = false;
    const racingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction') return (body: () => unknown) => {
          if (!injected) {
            injected = true;
            const other = new Database(fixture.dbPath);
            try {
              const from = 'commit-noise-0';
              const to = 'commit-noise-renamed';
              const row = other.prepare('SELECT id, title FROM entities WHERE name = ?').get(from) as {
                id: number;
                title: string | null;
              };
              const observations = indexedObservationText(other, row.id);
              other.transaction(() => {
                removeFromFts(other, row.id, from, observations, row.title);
                other.prepare('UPDATE entities SET name = ? WHERE id = ?').run(to, row.id);
                insertFtsRow(other, row.id, to, observations, row.title);
              }).immediate();
            } finally {
              other.close();
            }
          }
          return originalTransaction(body);
        };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof db;

    const result = compressWeeklyNoise(racingDb);

    expect(injected).toBe(true);
    expect(result.compressed).toBe(25);
    const renamed = db.prepare('SELECT id, status FROM entities WHERE name = ?').get(
      'commit-noise-renamed',
    ) as { id: number; status: string };
    expect(renamed.status).toBe('archived');
    expect(ftsRowCount(db, renamed.id)).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM entities_fts WHERE entities_fts MATCH 'renamed'").get(),
      'the concurrent new-name token remained in the contentless index',
    ).toEqual({ c: 0 });
    expect(() =>
      db.exec("INSERT INTO entities_fts(entities_fts) VALUES('integrity-check')")
    ).not.toThrow();
  });
});

describe('a re-remembered archived entity is searchable exactly once (D12)', () => {
  /** Archive the way the three leaky paths did: status only, indexes untouched. */
  function archiveWithoutTouchingIndexes(
    db: ReturnType<typeof getDatabase>,
    name: string,
  ): void {
    db.prepare("UPDATE entities SET status = 'archived' WHERE name = ?").run(name);
  }

  // There is deliberately no separate "two documents at one rowid" test.
  // Measured against FTS5 3.51.3: a second insert of IDENTICAL (or superset)
  // text at a rowid is not observable — `SELECT COUNT(*) … WHERE rowid = ?`,
  // `fts5vocab 'row'` and `fts5vocab 'instance'` all merge the postings, and a
  // later correct delete removes them all. An assertion on any of those would
  // have carried the defect's name while being unable to fail. The double
  // insert only leaves damage when the two documents DIFFER, and through
  // `createEntity` there is exactly one way for them to: the title, which is
  // folded into the indexed observation text. That is the case below, and it
  // is the whole of the observable defect.

  it('leaves no token behind that a later delete cannot reach', () => {
    // The permanent-token case, and it needs the two documents to DIVERGE:
    // measured against FTS5 directly, a second document that is a superset of
    // the first is still fully removed by a correct delete of its own text,
    // but one that dropped a term is not — the dropped term has no delete that
    // can ever name it. A title change between archive and re-remember does
    // exactly that, because the title is folded into the indexed observation
    // text (`foldTitleIntoObservations`).
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    kg.createEntity('commit-def5678', 'commit', {
      title: 'oldtitletoken parser work',
      observations: ['shared body text'],
    });
    archiveWithoutTouchingIndexes(db, 'commit-def5678');

    kg.createEntity('commit-def5678', 'commit', {
      title: 'newtitletoken lexer work',
      observations: ['shared body text'],
    });

    // The old title is gone from the index, not merely unreachable through the
    // entity: with the double insert it survived every subsequent delete.
    expect(kg.search('oldtitletoken')).toHaveLength(0);
    expect(kg.search('newtitletoken')).toHaveLength(1);
    expect(kg.search('newtitletoken').map((e) => e.name)).toEqual(['commit-def5678']);

    // And a proper archive now empties the row completely — the state the old
    // path could not reach for the first document's terms.
    kg.archiveEntity('commit-def5678');
    expect(kg.search('newtitletoken')).toHaveLength(0);
    expect(kg.search('oldtitletoken')).toHaveLength(0);
  });

  it('still works for an entity archived the clean way (no FTS row to delete)', () => {
    // `removeFromFts` prechecks for an absent row, so reading the previous text
    // unconditionally must not break the path that already removed the row.
    // Without this, the fix would trade one defect for a stderr warning on
    // every re-remember of a properly archived memory.
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    kg.createEntity('note-clean', 'note', { observations: ['cleanpathtoken here'] });
    kg.archiveEntity('note-clean');
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('note-clean') as {
      id: number;
    }).id;
    expect(ftsRowCount(db, id)).toBe(0);

    kg.createEntity('note-clean', 'note', { observations: ['cleanpathtoken here', 'and more'] });

    expect(ftsRowCount(db, id)).toBe(1);
    expect(kg.search('cleanpathtoken')).toHaveLength(1);
    expect(kg.search('cleanpathtoken').map((e) => e.name)).toEqual(['note-clean']);
  });
});

describe('the contentless delete never runs without a row to delete', () => {
  it('a second removeFromFts for the same text is a no-op, not a corrupt index', () => {
    // The mechanism, pinned directly. A contentless FTS5 'delete' writes
    // NEGATIVE postings and does not look for a row first; issued twice for
    // one (rowid, text) the counts go below zero and SQLite raises
    // `database disk image is malformed`. Measured on SQLite 3.51.3 outside
    // this codebase: insert, delete correctly, delete again -> that exact
    // error. `removeFromFts` must therefore refuse the second call rather
    // than rely on the benign-error classifier, which does not (and must
    // not) treat "malformed" as benign.
    //
    // This is the path `forget` then re-`remember` takes on EVERY properly
    // archived memory, so without the guard the fix for the double-INSERT
    // would have traded one defect for a worse one.
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    kg.createEntity('note-guarded', 'note', { observations: ['guardedtoken body'] });
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('note-guarded') as {
      id: number;
    }).id;

    removeFromFts(db, id, 'note-guarded', 'guardedtoken body', null);
    expect(ftsRowCount(db, id)).toBe(0);

    // The precheck owns the idempotent no-row case. A genuine delete failure
    // would be logged and rethrown so a caller transaction can roll back, but
    // this second call never issues the contentless FTS delete at all.
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        warnings.push(String(chunk));
        return true;
      });
    try {
      removeFromFts(db, id, 'note-guarded', 'guardedtoken body', null);
    } finally {
      spy.mockRestore();
    }
    expect(warnings.filter((w) => w.includes('removeFromFts'))).toEqual([]);
    expect(ftsRowCount(db, id)).toBe(0);
    expect(kg.search('guardedtoken')).toHaveLength(0);
  });
});
