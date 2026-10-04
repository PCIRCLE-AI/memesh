/**
 * The shared entity write kernel (src/storage/entity-write.ts), and the policy
 * each writer keeps on top of it. The kernel decides nothing; the second
 * describe block pins every place where core `createEntity` and the hooks'
 * `captureEntity` deliberately answer differently, so folding a policy into
 * the shared mechanism shows up as a failure here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';
import { addTags, appendObservations, insertOrGetEntity, reindexEntityFts, runEntityWrite } from '../../src/storage/entity-write.js';

const require = createRequire(import.meta.url);
const shared = require('../../scripts/hooks/_shared.js');

function ftsHits(db: MemeshDatabase, word: string): number[] {
  return (db.prepare('SELECT rowid FROM entities_fts WHERE entities_fts MATCH ? ORDER BY rowid').all(`"${word}"`) as Array<{ rowid: number }>)
    .map((r) => r.rowid);
}
function contents(db: MemeshDatabase, id: number): string[] {
  return (db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(id) as Array<{ content: string }>).map((r) => r.content);
}

describe('entity write kernel', () => {
  let tmpDir: string;
  let db: MemeshDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-entity-write-'));
    db = openDatabase(path.join(tmpDir, 'k.db'));
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('insertOrGetEntity: a new name is inserted; an existing one is returned untouched', () => {
    const first = insertOrGetEntity(db, { name: 'k1', type: 'note', metadataJson: '{"a":1}', title: 'T1' })!;
    expect(first.isNew).toBe(true);
    expect(first).toMatchObject({ type: 'note', title: 'T1', status: 'active', namespace: 'personal', metadata: '{"a":1}' });
    const again = insertOrGetEntity(db, { name: 'k1', type: 'decision', metadataJson: '{"b":2}', title: 'T2', namespace: 'team' })!;
    expect(again).toMatchObject({ id: first.id, isNew: false, type: 'note', title: 'T1', namespace: 'personal', metadata: '{"a":1}' });
    const team = insertOrGetEntity(db, { name: 'k2', type: 'note', metadataJson: '{}', title: null, namespace: 'team' })!;
    expect(team.namespace).toBe('team');
  });

  it('appendObservations: all three option combinations', () => {
    const id = insertOrGetEntity(db, { name: 'k3', type: 'note', metadataJson: '{}', title: null })!.id;
    // No dedupe: repeats are stored as given (core's lesson family).
    expect(appendObservations(db, id, ['a', 'a', 'b'], { dedupe: false, readExisting: true })).toEqual(['a', 'a', 'b']);
    // Dedupe against stored + within the call (core non-lesson, hook append).
    expect(appendObservations(db, id, ['a', 'c', 'c'], { dedupe: true, readExisting: true })).toEqual(['c']);
    // Dedupe within the call only (new entity, or hook after a replace delete).
    expect(appendObservations(db, id, ['a', 'd', 'd'], { dedupe: true, readExisting: false })).toEqual(['a', 'd']);
    // exclude runs first.
    expect(appendObservations(db, id, ['e', 'f'], { dedupe: true, readExisting: true, exclude: (o) => o === 'e' })).toEqual(['f']);
    expect(contents(db, id)).toEqual(['a', 'a', 'b', 'c', 'a', 'd', 'f']);
  });

  it('addTags ignores a tag the entity already has', () => {
    const id = insertOrGetEntity(db, { name: 'k4', type: 'note', metadataJson: '{}', title: null })!.id;
    addTags(db, id, ['x', 'y']);
    addTags(db, id, ['y', 'z']);
    expect((db.prepare('SELECT tag FROM tags WHERE entity_id = ? ORDER BY tag').all(id) as Array<{ tag: string }>).map((r) => r.tag)).toEqual(['x', 'y', 'z']);
  });

  it('reindexEntityFts: reads text and title from the database unless the caller knows them; a known null title and empty text are real values', () => {
    const id = insertOrGetEntity(db, { name: 'k5', type: 'note', metadataJson: '{}', title: 'Pelican' })!.id;
    appendObservations(db, id, ['osprey'], { dedupe: true, readExisting: false });
    reindexEntityFts(db, id, 'k5', undefined);
    expect(ftsHits(db, 'osprey')).toEqual([id]);
    expect(ftsHits(db, 'Pelican')).toEqual([id]);
    // Known values replace what is indexed, without reading the rows.
    reindexEntityFts(db, id, 'k5', { observationsText: 'osprey', title: 'Pelican' }, { observationsText: '', title: null });
    expect(ftsHits(db, 'osprey')).toEqual([]);
    expect(ftsHits(db, 'Pelican')).toEqual([]);
    expect(ftsHits(db, 'k5')).toEqual([id]);
    db.prepare("INSERT INTO entities_fts(entities_fts) VALUES('integrity-check')").run();
  });

  it('runEntityWrite rolls every step back when the write throws', () => {
    expect(() => runEntityWrite(db, () => {
      const id = insertOrGetEntity(db, { name: 'k6', type: 'note', metadataJson: '{}', title: null })!.id;
      appendObservations(db, id, ['gannet'], { dedupe: true, readExisting: false });
      reindexEntityFts(db, id, 'k6', undefined);
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.prepare("SELECT COUNT(*) AS c FROM entities WHERE name = 'k6'").get()).toEqual({ c: 0 });
    expect(ftsHits(db, 'gannet')).toEqual([]);
  });
});

describe('kept policy differences between the two writers (characterization)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-entity-write-policy-'));
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* not open */ }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function hookDb() {
    return shared.openHookDb({ ...process.env, MEMESH_DB_PATH: path.join(tmpDir, 'hook.db') }, { fts: true });
  }

  it('core keeps repeated lesson observations; the hook drops a repeat on any type', () => {
    const kg = new KnowledgeGraph(openDatabase(path.join(tmpDir, 'core.db')));
    const lessonId = kg.createEntity('lesson-x', 'lesson_learned', { observations: ['Error: e', 'Fix: a'] });
    kg.createEntity('lesson-x', 'lesson_learned', { observations: ['Error: e', 'Fix: b'] });
    expect(contents(kg['db'] as MemeshDatabase, lessonId)).toEqual(['Error: e', 'Fix: a', 'Error: e', 'Fix: b']);
    closeDatabase();
    const handle = hookDb();
    try {
      const r1 = shared.captureEntity(handle.db, { name: 'lesson-y', type: 'lesson_learned', observations: ['Error: e', 'Fix: a'] });
      shared.captureEntity(handle.db, { name: 'lesson-y', type: 'lesson_learned', observations: ['Error: e', 'Fix: b'] });
      expect(contents(handle.db, r1.id)).toEqual(['Error: e', 'Fix: a', 'Fix: b']);
    } finally { handle.db.close(); }
  });

  it('core restores an archived entity on re-write; the hook replace leaves it archived and unindexed', () => {
    const db = openDatabase(path.join(tmpDir, 'core.db'));
    const kg = new KnowledgeGraph(db);
    const id = kg.createEntity('arch-core', 'note', { observations: ['lemur'] });
    kg.archiveEntity('arch-core');
    kg.createEntity('arch-core', 'note', { observations: ['lemur two'] });
    expect(db.prepare('SELECT status FROM entities WHERE id = ?').get(id)).toEqual({ status: 'active' });
    expect(ftsHits(db, 'lemur')).toEqual([id]);
    closeDatabase();
    const handle = hookDb();
    try {
      const r = shared.captureEntity(handle.db, { name: 'session-a-files', type: 'session-insight', observations: ['tapir'], replace: true });
      handle.db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(r.id);
      const again = shared.captureEntity(handle.db, { name: 'session-a-files', type: 'session-insight', observations: ['tapir new'], replace: true });
      expect(again).toEqual({ id: r.id, isNew: false, archived: true });
      expect(contents(handle.db, r.id)).toEqual(['tapir']);
    } finally { handle.db.close(); }
  });

  it('core marks a changed title as user-provided; the hook marks it heuristic', () => {
    const db = openDatabase(path.join(tmpDir, 'core.db'));
    const kg = new KnowledgeGraph(db);
    const id = kg.createEntity('title-core', 'note', { observations: ['x'], title: 'One', metadata: { title_source: 'heuristic' } });
    kg.createEntity('title-core', 'note', { title: 'Two' });
    expect(JSON.parse((db.prepare('SELECT metadata FROM entities WHERE id = ?').get(id) as { metadata: string }).metadata).title_source).toBeUndefined();
    closeDatabase();
    const handle = hookDb();
    try {
      const r = shared.captureEntity(handle.db, { name: 'title-hook', type: 'commit', observations: ['y'], title: 'One' });
      shared.captureEntity(handle.db, { name: 'title-hook', type: 'commit', observations: [], title: 'Two' });
      const meta = JSON.parse((handle.db.prepare('SELECT metadata FROM entities WHERE id = ?').get(r.id) as { metadata: string }).metadata);
      expect(meta.title_source).toBe('heuristic');
    } finally { handle.db.close(); }
  });

  it('core moves an explicit namespace and canonicalizes the type; the hook does neither', () => {
    const db = openDatabase(path.join(tmpDir, 'core.db'));
    const kg = new KnowledgeGraph(db);
    const id = kg.createEntity('ns-core', 'mistake', { observations: ['x'] });
    kg.createEntity('ns-core', 'mistake', { namespace: 'team' });
    expect(db.prepare('SELECT type, namespace FROM entities WHERE id = ?').get(id)).toEqual({ type: 'lesson_learned', namespace: 'team' });
    closeDatabase();
    const handle = hookDb();
    try {
      const r = shared.captureEntity(handle.db, { name: 'ns-hook', type: 'mistake', observations: ['y'] });
      expect(handle.db.prepare('SELECT type, namespace FROM entities WHERE id = ?').get(r.id)).toEqual({ type: 'mistake', namespace: 'personal' });
    } finally { handle.db.close(); }
  });

  it('core raises confidence for a trusted new observation; the hook never touches confidence', () => {
    const db = openDatabase(path.join(tmpDir, 'core.db'));
    const kg = new KnowledgeGraph(db);
    const id = kg.createEntity('conf-core', 'note', { observations: ['x'] });
    db.prepare('UPDATE entities SET confidence = 0.5 WHERE id = ?').run(id);
    const before = (db.prepare('SELECT confidence FROM entities WHERE id = ?').get(id) as { confidence: number }).confidence;
    kg.createEntity('conf-core', 'note', { observations: ['y'] });
    expect((db.prepare('SELECT confidence FROM entities WHERE id = ?').get(id) as { confidence: number }).confidence).toBeGreaterThan(before);
    closeDatabase();
    const handle = hookDb();
    try {
      const r = shared.captureEntity(handle.db, { name: 'conf-hook', type: 'commit', observations: ['x'] });
      handle.db.prepare('UPDATE entities SET confidence = 0.5 WHERE id = ?').run(r.id);
      const c0 = (handle.db.prepare('SELECT confidence FROM entities WHERE id = ?').get(r.id) as { confidence: number }).confidence;
      shared.captureEntity(handle.db, { name: 'conf-hook', type: 'commit', observations: ['y'] });
      expect((handle.db.prepare('SELECT confidence FROM entities WHERE id = ?').get(r.id) as { confidence: number }).confidence).toBe(c0);
    } finally { handle.db.close(); }
  });

  it('the hook refuses a handoff write onto a different stored type and changes nothing', () => {
    const handle = hookDb();
    try {
      handle.db.prepare("INSERT INTO entities (name, type) VALUES ('session-handoff:px', 'decision')").run();
      expect(() => shared.captureEntity(handle.db, { name: 'session-handoff:px', type: 'session-handoff', observations: ['h'], replace: true, localHandoff: true }))
        .toThrow(/stored as type decision/);
      const row = handle.db.prepare("SELECT id FROM entities WHERE name = 'session-handoff:px'").get() as { id: number };
      expect(contents(handle.db, row.id)).toEqual([]);
    } finally { handle.db.close(); }
  });
});
