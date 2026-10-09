import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase } from '../src/db.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';

const cases = [
  { name: 'signal', marker: 'signal_score_backfill_v2', metadata: '{}', title: 'Existing title', query: 'SELECT id, name, type, metadata FROM entities', count: 'scored' },
  { name: 'trust', marker: 'accepted_proposal_trust_v1', metadata: '{"trust":"untrusted","proposal_id":123}', title: 'Existing title', query: 'SELECT id, metadata FROM entities', count: 'cleared' },
  { name: 'title', marker: 'title_backfill_v1', metadata: '{}', title: null, query: 'SELECT id, name, type, status, metadata FROM entities WHERE title IS NULL', count: 'titled' },
] as const;
let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-backfill-retry-')); file = path.join(dir, 'graph.db'); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });

function seed(c: typeof cases[number]) {
  const db = openDatabase(file);
  const id = db.prepare('INSERT INTO entities(name,type,title,metadata) VALUES (?,?,?,?)').run('owned-'+c.name, 'knowledge', c.title, c.metadata).lastInsertRowid;
  db.prepare('INSERT INTO observations(entity_id,content) VALUES (?,?)').run(id, 'Useful owned backfill observation.');
  db.prepare('DELETE FROM memesh_metadata WHERE key=? OR key LIKE ?').run(c.marker, c.marker+'_migration%');
  return { db, id };
}
function marker(db: MemeshDatabase, key: string): string | undefined {
  return (db.prepare('SELECT value FROM memesh_metadata WHERE key=?').get(key) as {value: string}|undefined)?.value;
}

describe('existing data backfills retry without blocking startup', () => {
  it.each(cases)('$name: permanent failure rolls back, opens, backs off, then retries with the original count marker', c => {
    const {db,id} = seed(c);
    db.exec("CREATE TRIGGER owned_backfill_failure BEFORE UPDATE OF metadata ON entities BEGIN SELECT RAISE(ABORT,'owned backfill failure'); END");
    const row = db.prepare('SELECT title,metadata FROM entities WHERE id=?').get(id);
    closeDatabase();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const opened = openDatabase(file);
    const attemptKey = c.marker+'_migration_last_attempt';
    expect(marker(opened,c.marker)).toBeUndefined();
    expect(Number(marker(opened,attemptKey))).toBeGreaterThan(Date.now()-10000);
    expect(opened.prepare('SELECT title,metadata FROM entities WHERE id=?').get(id)).toEqual(row);
    expect(stderr.mock.calls.flat().join('')).toContain('rolled back; completion is still pending');
    const attempts = stderr.mock.calls.length;
    opened.exec('DROP TRIGGER owned_backfill_failure');
    closeDatabase();
    const backedOff = openDatabase(file);
    expect(marker(backedOff,c.marker)).toBeUndefined();
    expect(backedOff.prepare('SELECT title,metadata FROM entities WHERE id=?').get(id)).toEqual(row);
    expect(stderr.mock.calls.length).toBe(attempts);
    backedOff.prepare('UPDATE memesh_metadata SET value=? WHERE key=?').run(String(Date.now()-25*60*60*1000),attemptKey);
    closeDatabase();
    const recovered = openDatabase(file);
    const done = JSON.parse(marker(recovered,c.marker)!);
    expect(done[c.count]).toBe(1);
    expect(done.skipped).toBe(0);
    expect(typeof done.at).toBe('string');
    expect(marker(recovered,attemptKey)).toBeUndefined();
    expect(marker(recovered,c.marker+'_migration')).toBe('1');
  });

  it.each(cases)('$name: a completed legacy JSON marker remains a no-op without new control facts', c => {
    const {db,id} = seed(c);
    const json = JSON.stringify({at:'2000-01-01T00:00:00Z',[c.count]:42,skipped:3});
    db.prepare('INSERT INTO memesh_metadata(key,value) VALUES (?,?)').run(c.marker,json);
    const row = db.prepare('SELECT title,metadata FROM entities WHERE id=?').get(id);
    closeDatabase();
    const reopened = openDatabase(file);
    expect(marker(reopened,c.marker)).toBe(json);
    expect(marker(reopened,c.marker+'_migration')).toBeUndefined();
    expect(reopened.prepare('SELECT title,metadata FROM entities WHERE id=?').get(id)).toEqual(row);
  });

  it.each(cases)('$name: the work-list read already holds the write lock against a real peer', c => {
    seed(c);closeDatabase();
    const peer = new MemeshDatabase(file);peer.exec('PRAGMA busy_timeout=1');
    const prepare = MemeshDatabase.prototype.prepare;
    let checked = false;let peerAcquired = false;
    const spy = vi.spyOn(MemeshDatabase.prototype,'prepare').mockImplementation(function(this:MemeshDatabase,sql:string) {
      if(this!==peer && !checked && sql.trim().startsWith(c.query)) {
        checked=true;
        try { peer.exec('BEGIN IMMEDIATE');peerAcquired=true;peer.exec('ROLLBACK'); }
        catch(error) { expect(String(error)).toMatch(/database is locked/); }
      }
      return prepare.call(this,sql);
    });
    try {
      const db = openDatabase(file);
      expect(checked).toBe(true);expect(peerAcquired).toBe(false);
      expect(JSON.parse(marker(db,c.marker)!)[c.count]).toBe(1);
      expect(marker(db,c.marker+'_migration_last_attempt')).toBeUndefined();
    } finally {spy.mockRestore();peer.close();}
  });
});
