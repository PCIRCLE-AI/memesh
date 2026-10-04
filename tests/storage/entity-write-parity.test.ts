/**
 * Both entity writers — core `KnowledgeGraph.createEntity` and the hooks'
 * `captureEntity` — go through the shared write kernel
 * (src/storage/entity-write.ts). Each keeps its own policy on top of it, and
 * the stored result must not move because the mechanism underneath was shared.
 *
 * Every scenario below runs a fixed sequence of writes and records the whole
 * resulting graph: entity rows (minus timestamps), observations in id order,
 * tags, the writers' return values, FTS hits for chosen words and the FTS5
 * integrity check. The file snapshots next to this test were recorded from the
 * writers as they were before the kernel existed, so a difference here is a
 * behaviour change, not a refactor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';

const require = createRequire(import.meta.url);
const shared = require('../../scripts/hooks/_shared.js');

/** Metadata keys whose value is a wall-clock time — dropped so the snapshot is deterministic. */
const TIME_KEYS = new Set(['namespace_moved_at']);

function snapshot(db: MemeshDatabase, words: string[], results: unknown[]) {
  const entities = (db.prepare(
    'SELECT id, name, type, title, status, namespace, confidence, metadata FROM entities ORDER BY id',
  ).all() as Array<Record<string, unknown>>).map((row) => {
    const meta = row.metadata ? JSON.parse(String(row.metadata)) : null;
    if (meta && typeof meta === 'object') for (const k of TIME_KEYS) delete (meta as Record<string, unknown>)[k];
    return { ...row, metadata: meta };
  });
  const observations = db.prepare('SELECT id, entity_id, content FROM observations ORDER BY id').all();
  const tags = db.prepare('SELECT entity_id, tag FROM tags ORDER BY entity_id, tag').all();
  const fts: Record<string, number[]> = {};
  for (const w of words) {
    fts[w] = (db.prepare('SELECT rowid FROM entities_fts WHERE entities_fts MATCH ? ORDER BY rowid').all(`"${w}"`) as Array<{ rowid: number }>)
      .map((r) => r.rowid);
  }
  let integrity = 'ok';
  try {
    db.prepare("INSERT INTO entities_fts(entities_fts) VALUES('integrity-check')").run();
  } catch (err) {
    integrity = err instanceof Error ? err.message : String(err);
  }
  return { results, entities, observations, tags, fts, integrity };
}

describe('entity writers: stored result unchanged by the shared kernel', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-entity-write-parity-'));
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* not open */ }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('core createEntity: append, dedupe, lesson repeats, title, namespace, archive restore, trust, forgotten, clear', async () => {
    const db = openDatabase(path.join(tmpDir, 'core.db'));
    const kg = new KnowledgeGraph(db);
    const results: unknown[] = [];
    results.push(kg.createEntity('alpha-note', 'note', { observations: ['otter swims', 'otter sleeps'], tags: ['project:p1', 'topic:otter'], title: 'Otter facts' }));
    results.push(kg.createEntity('alpha-note', 'note', { observations: ['otter sleeps', 'otter eats clams', 'otter eats clams'], tags: ['topic:otter', 'topic:clam'] }));
    results.push(kg.createEntity('alpha-note', 'note', { title: 'Sea otter facts' }));
    results.push(kg.createEntity('alpha-note', 'note', { observations: ['otter floats'], trustOverride: 'untrusted' }));
    results.push(kg.createEntity('beta-lesson', 'lesson_learned', { observations: ['Error: heron stuck', 'Fix: heron A'] }));
    results.push(kg.createEntity('beta-lesson', 'lesson_learned', { observations: ['Error: heron stuck', 'Fix: heron B'] }));
    results.push(kg.createEntity('gamma-mistake', 'mistake', { observations: ['Error: walrus', 'Error: walrus'] }));
    results.push(kg.createEntity('delta-team', 'note', { observations: ['puffin flies'], namespace: 'personal' }));
    results.push(kg.createEntity('delta-team', 'note', { observations: ['puffin dives'], namespace: 'team' }));
    results.push(kg.createEntity('epsilon-archived', 'note', { observations: ['lynx hunts'] }));
    kg.archiveEntity('epsilon-archived');
    results.push(kg.createEntity('epsilon-archived', 'note', { observations: ['lynx hunts', 'lynx naps'] }));
    results.push(kg.createEntity('session-s1-files', 'session-insight', { observations: ['badger a', 'badger b'] }));
    results.push(kg.removeObservation('session-s1-files', 'badger b'));
    results.push(kg.createEntity('session-s1-files', 'session-insight', { observations: ['badger b', 'badger c'], trustOverride: 'untrusted' }));
    results.push(kg.createEntity('session-s1-files', 'session-insight', { observations: ['badger b'] }));
    results.push(kg.createEntity('zeta-clear', 'note', { observations: ['ibis old'], tags: ['topic:ibis'], title: 'Ibis' }));
    kg.clearEntityData('zeta-clear');
    results.push(kg.createEntity('zeta-clear', 'note', { observations: ['ibis new'], tags: ['topic:ibis2'] }));
    results.push(kg.createEntity('eta-empty', 'note', {}));
    const snap = snapshot(db, ['otter', 'clams', 'floats', 'Sea', 'heron', 'walrus', 'puffin', 'lynx', 'naps', 'badger', 'ibis', 'old', 'new', 'eta'], results);
    await expect(JSON.stringify(snap, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/entity-write-parity.core.json');
  });

  it('hook captureEntity: append, dedupe, title update, replace, archived no-op, localHandoff, forgotten on replace', async () => {
    const handle = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: path.join(tmpDir, 'hook.db') }, { fts: true });
    const db = handle.db as MemeshDatabase;
    const results: unknown[] = [];
    try {
      const cap = (args: Record<string, unknown>) => {
        try { return shared.captureEntity(db, args); } catch (err) { return { threw: err instanceof Error ? err.message : String(err) }; }
      };
      results.push(cap({ name: 'commit-aaa', type: 'commit', observations: ['raven commit one', 'raven commit one'], tags: ['auto-capture', 'project:p1'], title: 'Raven commit', metadata: { session_id: 's1' }, sourceHost: 'claude-code' }));
      results.push(cap({ name: 'commit-aaa', type: 'commit', observations: ['raven commit one', 'raven commit two'], tags: ['auto-capture'], title: 'Raven commit v2', sourceHost: 'codex' }));
      results.push(cap({ name: 'pre-compact-s1', type: 'session-summary', observations: ['crane compaction'], tags: ['urgency:pre-compact'] }));
      results.push(cap({ name: 'pre-compact-s1', type: 'session-summary', observations: ['crane compaction', 'crane tool calls 3'] }));
      results.push(cap({ name: 'session-s2-files', type: 'session-insight', observations: ['stoat a', 'stoat b'], tags: ['file:a.ts'], title: 'Files', replace: true, sourceHost: 'claude-code' }));
      results.push(cap({ name: 'session-s2-files', type: 'session-insight', observations: ['stoat c'], tags: ['file:c.ts'], title: 'Files', replace: true, sourceHost: 'claude-code' }));
      results.push(cap({ name: 'session-s2-files', type: 'session-insight', observations: [], tags: [], replace: true }));
      results.push(cap({ name: 'session-s3-files', type: 'session-insight', observations: ['marten a', 'marten b'], replace: true }));
      const marten = db.prepare("SELECT id, metadata FROM entities WHERE name = 'session-s3-files'").get() as { id: number; metadata: string };
      const crypto = await import('node:crypto');
      const hash = crypto.createHash('sha256').update('marten b').digest('hex');
      db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(marten.metadata), forgotten_observation_hashes: [hash] }), marten.id);
      results.push(cap({ name: 'session-s3-files', type: 'session-insight', observations: ['marten a', 'marten b', 'marten c'], replace: true }));
      results.push(cap({ name: 'session-s4-files', type: 'session-insight', observations: ['vole kept'], replace: true }));
      const vole = db.prepare("SELECT id FROM entities WHERE name = 'session-s4-files'").get() as { id: number };
      const { removeFromFts } = require('../../scripts/hooks/_generated/fts-index.js');
      removeFromFts(db, vole.id, 'session-s4-files', 'vole kept', null);
      db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(vole.id);
      results.push(cap({ name: 'session-s4-files', type: 'session-insight', observations: ['vole overwrite'], replace: true }));
      results.push(cap({ name: 'session-handoff:p1', type: 'session-handoff', observations: ['handoff kestrel one'], tags: ['auto-capture', 'project:p1'], title: 'Handoff', replace: true, localHandoff: true, sourceHost: 'claude-code' }));
      results.push(cap({ name: 'session-handoff:p1', type: 'session-handoff', observations: ['handoff kestrel two'], tags: ['auto-capture', 'project:p1'], title: 'Handoff', replace: true, localHandoff: true, sourceHost: 'claude-code' }));
      db.prepare("INSERT INTO entities (name, type) VALUES ('session-handoff:p2', 'decision')").run();
      results.push(cap({ name: 'session-handoff:p2', type: 'session-handoff', observations: ['handoff should not land'], replace: true, localHandoff: true }));
      results.push(cap({ name: 'untitled-commit', type: 'commit', observations: ['shrike'], title: null }));
      const snap = snapshot(db, ['raven', 'two', 'v2', 'crane', 'calls', 'stoat', 'a', 'c', 'marten', 'vole', 'overwrite', 'kestrel', 'one', 'land', 'shrike', 'Files'], results);
      await expect(JSON.stringify(snap, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/entity-write-parity.hook.json');
    } finally {
      handle.close?.();
      try { db.close(); } catch { /* already closed */ }
    }
  });
});
