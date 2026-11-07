import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { openHookDb } from '../../scripts/hooks/_shared.js';
import { forget, remember } from '../../src/core/operations.js';
import { computePatterns } from '../../src/core/patterns.js';
import { backfillCompressionMarkers, compressWeeklyNoise } from '../../src/core/lifecycle.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const handle = useTestDatabase('memesh-marker-backfill-');
const KEY = 'compression_marker_backfill';
const backupsDir = () => path.join(path.dirname(handle.dbPath), 'backups');
const totalCommits = () => computePatterns(getDatabase(), ['workflow']).workflow.totalCommits;

/** Commits ten days old, compressed by today's code, then made to look as an older version left them: archived, unmarked. */
function legacyCompressedWeek(n: number, forgetFirst = 0): void {
  for (let i = 0; i < n; i++) remember({ name: `old-commit-${i}`, type: 'commit', observations: [`fix: ${i}`] });
  getDatabase().exec("UPDATE entities SET created_at = datetime('now', '-10 days', '+3 hours') WHERE name LIKE 'old-commit-%'");
  for (let i = 0; i < forgetFirst; i++) forget({ name: `old-commit-${i}` });
  compressWeeklyNoise(getDatabase());
  getDatabase().exec("UPDATE entities SET metadata = json_remove(metadata, '$.compacted_into') WHERE type = 'commit' AND status = 'archived'");
  getDatabase().prepare('DELETE FROM memesh_metadata WHERE key = ?').run(KEY);
}

describe('marking records that earlier versions archived by compression', () => {
  it('marks a week whose summary accounts for every archived commit, after a backup, and counts them again', () => {
    legacyCompressedWeek(25);
    expect(totalCommits()).toBe(0);
    backfillCompressionMarkers(getDatabase());
    expect(totalCommits()).toBe(25);
    const backups = fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()) : [];
    expect(backups.filter((f) => f.startsWith('before-compression-marker-'))).toHaveLength(1);
    expect(getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeTruthy();
  });

  it('is idempotent: a second run changes no row and makes no second backup', () => {
    legacyCompressedWeek(25);
    backfillCompressionMarkers(getDatabase());
    const snapshot = () => JSON.stringify(getDatabase().prepare("SELECT id, metadata FROM entities ORDER BY id").all());
    const before = snapshot();
    getDatabase().prepare('DELETE FROM memesh_metadata WHERE key = ?').run(KEY);
    backfillCompressionMarkers(getDatabase());
    expect(snapshot()).toBe(before);
    expect(fs.readdirSync(backupsDir()).filter((f) => f.startsWith('before-compression-marker-'))).toHaveLength(1);
  });

  it('leaves a week alone when a forgotten commit sits among the archived ones, and never revives it', () => {
    legacyCompressedWeek(25, 2);
    backfillCompressionMarkers(getDatabase());
    // 23 were compressed, 25 are archived: two were forgotten and nothing says which.
    expect(totalCommits()).toBe(0);
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'commit' AND metadata LIKE '%compacted_into%'").get() as { n: number }).n).toBe(0);
  });

  it('changes nothing and stays pending when the backup cannot be made', () => {
    legacyCompressedWeek(25);
    fs.writeFileSync(backupsDir(), 'a file where the folder should be');
    backfillCompressionMarkers(getDatabase());
    expect(totalCommits()).toBe(0);
    expect(getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeUndefined();
  });

  const leaseKey = `${KEY}_lease`;
  const finalBackups = () => (fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()) : []).filter((f) => f.startsWith('before-compression-marker-') && f.endsWith('.db'));

  describe('who runs it, and how many at once', () => {
    it('is not run by a hook that opens the database with a time limit', () => {
      legacyCompressedWeek(25);
      closeDatabase();
      openDatabase(handle.dbPath, { busyTimeoutMs: 2000 });
      expect(totalCommits()).toBe(0);
      expect(finalBackups()).toEqual([]);
      expect(getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeUndefined();
    });

    it('is not run by the hooks\' own opener either', () => {
      legacyCompressedWeek(25);
      closeDatabase();
      const { db } = openHookDb({ ...process.env, MEMESH_DB_PATH: handle.dbPath });
      try {
        expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeUndefined();
      } finally {
        db.close();
      }
      expect(finalBackups()).toEqual([]);
    });

    it('is run by an ordinary open (server, MCP, CLI), once', () => {
      legacyCompressedWeek(25);
      closeDatabase();
      openDatabase(handle.dbPath);
      expect(totalCommits()).toBe(25);
      expect(finalBackups()).toHaveLength(1);
    });

    it('does nothing while another process holds an unexpired claim, and leaves that claim alone', () => {
      legacyCompressedWeek(25);
      const claim = `99999:${Date.now() + 600_000}`;
      getDatabase().prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(leaseKey, claim);
      backfillCompressionMarkers(getDatabase());
      expect(totalCommits()).toBe(0);
      expect(finalBackups()).toEqual([]);
      expect((getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(leaseKey) as { value: string }).value).toBe(claim);
    });

    it('two processes opening at once make one backup and one marking', () => {
      legacyCompressedWeek(25);
      closeDatabase();
      const script = "import('" + path.resolve('dist/db.js') + "').then((m) => { m.openDatabase(); m.closeDatabase(); })";
      const env = { ...process.env, MEMESH_DB_PATH: handle.dbPath, MEMESH_DIR: path.dirname(handle.dbPath) };
      const runs = [0, 1].map(() => new Promise<string>((resolve) => {
        const child = spawn(process.execPath, ['-e', script], { env });
        let err = '';
        child.stderr.on('data', (d) => { err += String(d); });
        child.on('close', () => resolve(err));
      }));
      return Promise.all(runs).then((errs) => {
        const text = errs.join('');
        expect(text.match(/marked 25 archived records/g) ?? []).toHaveLength(1);
        expect(finalBackups()).toHaveLength(1);
        openDatabase(handle.dbPath);
        expect(totalCommits()).toBe(25);
      });
    });

    it('finishes after a killed run: expired claim and half-written copy are cleaned up, one complete backup remains', () => {
      legacyCompressedWeek(25);
      fs.mkdirSync(backupsDir(), { recursive: true });
      fs.writeFileSync(path.join(backupsDir(), 'before-compression-marker-2026-01-01T00-00-00-000Z.db.tmp'), 'half a backup');
      getDatabase().prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(leaseKey, `424242:${Date.now() - 1000}`);
      backfillCompressionMarkers(getDatabase());
      expect(totalCommits()).toBe(25);
      expect(fs.readdirSync(backupsDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(finalBackups()).toHaveLength(1);
      const copy = fs.readFileSync(path.join(backupsDir(), finalBackups()[0]));
      expect(copy.subarray(0, 15).toString()).toBe('SQLite format 3');
      expect(getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(leaseKey)).toBeUndefined();
    });
  });
});
