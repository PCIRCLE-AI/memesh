import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

let dir: string;
let db: ReturnType<typeof openDatabase>;
let kg: KnowledgeGraph;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-observation-integrity-'));
  db = openDatabase(path.join(dir, 'graph.db'));
  kg = new KnowledgeGraph(db);
  kg.createEntity('edited', 'note', {
    title: 'gazelle title',
    observations: ['obsolete quokka', 'retained wombat'],
  });
  kg.createEntity('untouched', 'note', { observations: ['independent ibex'] });
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function failingGraph(failOn: RegExp): KnowledgeGraph {
  return new KnowledgeGraph(new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        if (failOn.test(sql)) throw new Error('injected index failure');
        return target.prepare(sql);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }));
}

describe('observation removal integrity', () => {
  it('keeps the observation and prior FTS row when the replacement FTS insert fails', () => {
    const before = kg.getEntity('edited')!.observations;
    expect(before).toHaveLength(2);

    expect(() => failingGraph(/INSERT INTO entities_fts \(rowid/)
      .removeObservation('edited', 'obsolete quokka'))
      .toThrow('injected index failure');

    expect(kg.getEntity('edited')!.observations).toEqual(before);
    expect(kg.search('quokka').map((entity) => entity.name)).toEqual(['edited']);
    expect(kg.search('wombat').map((entity) => entity.name)).toEqual(['edited']);
  });

  it('keeps the observation and prior FTS row when deleting the old FTS row fails', () => {
    const before = kg.getEntity('edited')!.observations;
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        warnings.push(String(chunk));
        return true;
      });

    try {
      expect(() => failingGraph(/INSERT INTO entities_fts \(entities_fts, rowid/)
        .removeObservation('edited', 'obsolete quokka'))
        .toThrow('injected index failure');
    } finally {
      spy.mockRestore();
    }

    expect(warnings.some((warning) => warning.includes('removeFromFts'))).toBe(true);
    expect(kg.getEntity('edited')!.observations).toEqual(before);
    expect(kg.search('quokka').map((entity) => entity.name)).toEqual(['edited']);
    expect(kg.search('wombat').map((entity) => entity.name)).toEqual(['edited']);
  });

  it('removes only the earliest matching row when observation text is repeated', () => {
    kg.createEntity('lesson-repeat', 'lesson_learned', {
      observations: ['Error: X', 'Fix: A', 'Error: X', 'Fix: B'],
    });

    expect(kg.removeObservation('lesson-repeat', 'Error: X')).toEqual({
      removed: true,
      remainingObservations: 3,
      entityFound: true,
    });

    expect(kg.getEntity('lesson-repeat')!.observations).toEqual([
      'Fix: A',
      'Error: X',
      'Fix: B',
    ]);
    expect(kg.search('Error').map((entity) => entity.name)).toEqual(['lesson-repeat']);
  });

  it('does not recreate an FTS row when removing an observation from an archived entity', () => {
    const id = kg.getEntity('edited')!.id;
    kg.archiveEntity('edited');
    expect(db.prepare('SELECT rowid FROM entities_fts WHERE rowid = ?').all(id)).toEqual([]);

    expect(kg.removeObservation('edited', 'obsolete quokka')).toEqual({
      removed: true,
      remainingObservations: 1,
      entityFound: true,
    });

    expect(db.prepare('SELECT rowid FROM entities_fts WHERE rowid = ?').all(id)).toEqual([]);
    expect(db.prepare('SELECT status FROM entities WHERE id = ?').get(id)).toMatchObject({ status: 'archived' });
    expect(kg.search('wombat')).toEqual([]);
  });

  it('removes the final observation while preserving the searchable title', () => {
    kg.removeObservation('edited', 'obsolete quokka');
    expect(kg.removeObservation('edited', 'retained wombat')).toEqual({
      removed: true,
      remainingObservations: 0,
      entityFound: true,
    });
    expect(kg.getEntity('edited')!.observations).toEqual([]);
    expect(kg.search('wombat')).toEqual([]);
    expect(kg.search('gazelle').map((entity) => entity.name)).toEqual(['edited']);
  });

  it('does not touch the FTS index for a missing observation or entity', () => {
    const graph = failingGraph(/INSERT INTO entities_fts/);
    expect(graph.removeObservation('edited', 'absent')).toEqual({
      removed: false,
      remainingObservations: 2,
      entityFound: true,
    });
    expect(graph.removeObservation('missing', 'absent')).toEqual({
      removed: false,
      remainingObservations: 0,
      entityFound: false,
    });
    expect(kg.search('quokka').map((entity) => entity.name)).toEqual(['edited']);
    expect(kg.search('ibex').map((entity) => entity.name)).toEqual(['untouched']);
  });
});
