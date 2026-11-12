import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { closeDatabase, getDatabase, openDatabase, openInitialisedDatabase } from '../../src/db.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { openHookDb } from '../../scripts/hooks/_shared.js';
import { forget, remember } from '../../src/core/operations.js';
import { computePatterns } from '../../src/core/patterns.js';
import { backfillCompressionMarkers, compressWeeklyNoise } from '../../src/core/lifecycle.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const handle = useTestDatabase('memesh-marker-backfill-');
const KEY = 'compression_marker_backfill';
const backupsDir = () => path.join(path.dirname(handle.dbPath), 'backups');
const totalCommits = () => computePatterns(getDatabase(), ['workflow']).workflow.totalCommits;
const markedCount = () => (getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'commit' AND json_type(metadata, '$.compacted_into') = 'integer'").get() as { n: number }).n;
const markerOf = (name: string) => (getDatabase().prepare("SELECT json_extract(metadata, '$.compacted_into') AS m FROM entities WHERE name = ?").get(name) as { m: number | null }).m;
const statusOf = (name: string) => (getDatabase().prepare('SELECT status FROM entities WHERE name = ?').get(name) as { status: string }).status;
const summaryId = (week: string) => (getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(`weekly-summary-${week}`) as { id: number }).id;

// Fixed dates, so a week and its compression time never depend on today's clock.
// 2026-W10 runs Monday 2026-03-09 to Sunday 2026-03-15; 2026-W11 the week after.
function commitAt(name: string, createdAt: string, type = 'commit'): void {
  remember({ name, type, observations: [`fix: ${name}`] });
  getDatabase().prepare('UPDATE entities SET created_at = ? WHERE name = ?').run(createdAt, name);
}

/** Compress as if the clock read `at`; the summary observation it writes gets that time too. */
function compressAt(at: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM memesh_metadata WHERE key = 'last_noise_compress_at'").run();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  try {
    compressWeeklyNoise(db);
  } finally {
    vi.useRealTimers();
  }
  db.prepare("UPDATE observations SET created_at = datetime(?) WHERE id = (SELECT MAX(o.id) FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.type = 'weekly-summary')").run(at);
}

/** Strip the markers today's compression wrote, the way rows compressed by an earlier version look, and make the backfill pending. */
function asLegacy(): void {
  getDatabase().exec("UPDATE entities SET metadata = json_remove(metadata, '$.compacted_into') WHERE status = 'archived' AND json_valid(metadata)");
  getDatabase().prepare('DELETE FROM memesh_metadata WHERE key = ?').run(KEY);
}

/** `n` commits of 2026-W10 old enough for a compression on 2026-03-19 (cutoff 2026-03-12 12:00). */
function oldW10(n: number, prefix = 'c'): void {
  for (let i = 0; i < n; i++) commitAt(`${prefix}-${i}`, `2026-03-10 ${String(8 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`);
}

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

  it('leaves a week alone when a forgotten commit sits among the archived ones, never revives it, but still counts the commits its summary declared', () => {
    legacyCompressedWeek(25, 2);
    backfillCompressionMarkers(getDatabase());
    // 23 were compressed, 25 are archived: two were forgotten and nothing says which.
    // No row is marked; the summary's own 23 still go into the commit total.
    expect(totalCommits()).toBe(23);
    expect(markedCount()).toBe(0);
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

    it('a process that sees a held claim makes no backup and marks nothing, every time', async () => {
      // Deterministic form of "two at once": a claim another process holds is
      // in place before the spawned processes start, so without the claim
      // check every one of them would back up and mark.
      legacyCompressedWeek(25);
      const claim = `99999:${Date.now() + 600_000}`;
      getDatabase().prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(leaseKey, claim);
      closeDatabase();
      const script = `import(${JSON.stringify(pathToFileURL(path.resolve('dist/db.js')).href)}).then((m) => { m.openDatabase(); m.closeDatabase(); })`;
      const env = { ...process.env, MEMESH_DB_PATH: handle.dbPath, MEMESH_DIR: path.dirname(handle.dbPath) };
      const runOnce = () => new Promise<{ err: string; code: number | null }>((resolve) => {
        const child = spawn(process.execPath, ['-e', script], { env });
        let err = '';
        child.stderr.on('data', (d) => { err += String(d); });
        child.on('close', (code) => resolve({ err, code }));
      });
      // One after the other, so each meets the claim (two at once can instead meet each other's write lock).
      const runs = [await runOnce(), await runOnce()];
      // Each process must have RUN and met the held claim: a script that never started (a dist/ that is missing, or
      // that does not load) exits non-zero, and one that ran but ignored the claim does not print this line.
      for (const run of runs) {
        expect(run.code, run.err).toBe(0);
        expect(run.err).toMatch(/marker backfill skipped: another process is running it/);
      }
      expect(runs.map((run) => run.err).join('')).not.toMatch(/marked \d+ archived record/);
      expect(finalBackups()).toEqual([]);
      openDatabase(handle.dbPath, { busyTimeoutMs: 2000 });
      expect(totalCommits()).toBe(0);
      expect((getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(leaseKey) as { value: string }).value).toBe(claim);
    });

    it('is not run by a handle opened without maintenance (the rename-project preview copy)', () => {
      legacyCompressedWeek(25);
      closeDatabase();
      const copy = openInitialisedDatabase(handle.dbPath);
      try {
        expect(copy.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeUndefined();
      } finally {
        copy.close();
      }
      expect(finalBackups()).toEqual([]);
    });

    it('defers, without waiting out the lock or making a backup, while another connection holds the write lock', { timeout: 60_000 }, () => {
      legacyCompressedWeek(25);
      const busyTimeout = () => (getDatabase().prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
      // What every handle starts with. The open above already ran the backfill once.
      const fresh = new MemeshDatabase(':memory:');
      const timeoutBefore = (fresh.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
      fresh.close();
      expect(timeoutBefore).toBeGreaterThan(0);
      expect(busyTimeout()).toBe(timeoutBefore);
      const peer = new MemeshDatabase(handle.dbPath);
      const stderr = captureStderr();
      const started = Date.now();
      try {
        peer.exec('BEGIN IMMEDIATE');
        expect(() => backfillCompressionMarkers(getDatabase())).not.toThrow();
      } finally {
        stderr.restore();
        try { peer.exec('ROLLBACK'); } catch { /* not in a transaction */ }
        peer.close();
      }
      expect(Date.now() - started).toBeLessThan(5000);
      expect(stderr.text()).toMatch(/compressed-record marker backfill deferred/);
      expect(finalBackups()).toEqual([]);
      expect(getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeUndefined();
      // Not waiting was for the claim only: the shared handle keeps its own wait.
      expect(busyTimeout()).toBe(timeoutBefore);
      // The next start does it.
      backfillCompressionMarkers(getDatabase());
      expect(totalCommits()).toBe(25);
      expect(busyTimeout()).toBe(timeoutBefore);
    });
  });

  describe('which records a backfill may mark', () => {
    const W10_COMPRESSION = '2026-03-19T12:00:00.000Z'; // cutoff 2026-03-12 12:00
    const W11_COMPRESSION = '2026-03-26T12:00:00.000Z'; // cutoff 2026-03-19 12:00

    it('does not mark a commit forgotten before compression when a compressed one was remembered again', () => {
      // Before: 24 archived unmarked rows (23 compressed + the forgotten c-0)
      // equalled the summary's 24, so c-0 was marked and counted.
      oldW10(25);
      forget({ name: 'c-0' });
      compressAt(W10_COMPRESSION);
      asLegacy();
      remember({ name: 'c-5', type: 'commit', observations: ['fix: c-5'] });
      backfillCompressionMarkers(getDatabase());
      expect(markerOf('c-0')).toBeNull();
      expect(markedCount()).toBe(0);
      // 23 compressed (declared 24, one of them is active again) + c-5 itself.
      expect(totalCommits()).toBe(24);
    });

    it('still marks a normal week that keeps newer active commits the compression was too early for', () => {
      oldW10(25);
      for (let i = 0; i < 3; i++) commitAt(`tail-${i}`, `2026-03-13 1${i}:00:00`);
      compressAt(W10_COMPRESSION);
      asLegacy();
      backfillCompressionMarkers(getDatabase());
      expect(markedCount()).toBe(25);
      expect(['tail-0', 'tail-1', 'tail-2'].map(statusOf)).toEqual(['active', 'active', 'active']);
      expect(totalCommits()).toBe(28);
    });

    it('marks the week with a tail and a remembered-again commit, and leaves the week with a forget alone', () => {
      oldW10(25);
      for (let i = 0; i < 3; i++) commitAt(`tail-${i}`, `2026-03-13 1${i}:00:00`);
      compressAt(W10_COMPRESSION);
      for (let i = 0; i < 25; i++) commitAt(`d-${i}`, `2026-03-17 ${String(8 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`);
      forget({ name: 'd-0' });
      compressAt(W11_COMPRESSION);
      asLegacy();
      remember({ name: 'c-5', type: 'commit', observations: ['fix: c-5'] });
      remember({ name: 'd-5', type: 'commit', observations: ['fix: d-5'] });
      backfillCompressionMarkers(getDatabase());
      const w10 = summaryId('2026-W10');
      expect(markedCount()).toBe(24);
      expect(markerOf('c-1')).toBe(w10);
      expect(markerOf('d-0')).toBeNull();
      expect(markerOf('d-1')).toBeNull();
      // W10: 24 marked + c-5 + 3 tail. W11: 23 of its declared 24 still archived + d-5.
      expect(totalCommits()).toBe(28 + 24);
    });

    it('counts a week that a newer compression appended to before the backfill ran', () => {
      // The hook compresses at session start and never runs the backfill; its
      // newer batch is marked and adds to the same summary's declared count.
      oldW10(25);
      compressAt(W10_COMPRESSION);
      asLegacy();
      for (let i = 0; i < 25; i++) commitAt(`e-${i}`, `2026-03-14 ${String(8 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`);
      compressAt(W11_COMPRESSION);
      expect(markedCount()).toBe(25);
      backfillCompressionMarkers(getDatabase());
      expect(markedCount()).toBe(50);
      expect(totalCommits()).toBe(50);
    });

    it('counts a marked record that is active again once, as remembered, not also as already marked', () => {
      // A build that kept the marker on re-remember left such a row behind.
      oldW10(25);
      compressAt(W10_COMPRESSION);
      asLegacy();
      getDatabase().exec("UPDATE entities SET status = 'active', metadata = json_set(COALESCE(metadata, '{}'), '$.compacted_into', (SELECT id FROM entities WHERE name = 'weekly-summary-2026-W10')) WHERE name = 'c-0'");
      backfillCompressionMarkers(getDatabase());
      expect(markerOf('c-1')).toBe(summaryId('2026-W10'));
      expect(markedCount()).toBe(25);
      expect(totalCommits()).toBe(25);
    });

    it('marks each week to its own summary when two weeks declare the same count', () => {
      oldW10(25);
      for (let i = 0; i < 28; i++) commitAt(`d-${i}`, `2026-03-17 ${String(8 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`);
      for (let i = 0; i < 3; i++) forget({ name: `d-${i}` });
      compressAt(W10_COMPRESSION);
      compressAt(W11_COMPRESSION);
      asLegacy();
      backfillCompressionMarkers(getDatabase());
      expect(markerOf('c-3')).toBe(summaryId('2026-W10'));
      expect(markedCount()).toBe(25);
      expect(markerOf('d-10')).toBeNull();
    });

    it('never takes rows from the same week number of another year', () => {
      oldW10(25);
      compressAt(W10_COMPRESSION);
      // 2025-W10, archived with no summary of its own: forgotten, as far as anyone can tell.
      for (let i = 0; i < 25; i++) commitAt(`y-${i}`, `2025-03-04 ${String(8 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`);
      getDatabase().exec("UPDATE entities SET status = 'archived' WHERE name LIKE 'y-%'");
      asLegacy();
      backfillCompressionMarkers(getDatabase());
      expect(markerOf('c-0')).toBe(summaryId('2026-W10'));
      expect(markerOf('y-0')).toBeNull();
      expect(markedCount()).toBe(25);
    });

    it('adds up every observation of a summary that was appended to', () => {
      oldW10(25);
      compressAt(W10_COMPRESSION);
      for (let i = 0; i < 20; i++) commitAt(`e-${i}`, `2026-03-14 ${String(8 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`);
      compressAt(W11_COMPRESSION);
      asLegacy();
      expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'commit' AND status = 'active'").get() as { n: number }).n).toBe(0);
      backfillCompressionMarkers(getDatabase());
      expect(markedCount()).toBe(45);
      expect(totalCommits()).toBe(45);
    });

    it('marks rows whose metadata is NULL, as older versions wrote them', () => {
      legacyCompressedWeek(25);
      getDatabase().exec("UPDATE entities SET metadata = NULL WHERE type = 'commit'");
      backfillCompressionMarkers(getDatabase());
      expect(markedCount()).toBe(25);
    });

    it('marks JSON null metadata, never rewrites other metadata that is not an object, still counts those, and finishes', () => {
      legacyCompressedWeek(25);
      const set = getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?');
      const values = ['null', '5', '"x"', '[1]'];
      values.forEach((value, i) => set.run(value, `old-commit-${i}`));
      backfillCompressionMarkers(getDatabase());
      expect(getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeTruthy();
      expect(markerOf('old-commit-0')).toBe((getDatabase().prepare("SELECT id FROM entities WHERE type = 'weekly-summary'").get() as { id: number }).id);
      const metaOf = (name: string) => String((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(name) as { metadata: unknown }).metadata);
      expect([1, 2, 3].map((i) => metaOf(`old-commit-${i}`))).toEqual(values.slice(1));
      expect(markedCount()).toBe(22);
      // The three it would not rewrite are proven compressed: they count in the total.
      expect(totalCommits()).toBe(25);
    });

    it('never rewrites metadata it cannot read, and still finishes', () => {
      legacyCompressedWeek(25);
      getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run('{bad', 'old-commit-0');
      expect(() => backfillCompressionMarkers(getDatabase())).not.toThrow();
      expect((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get('old-commit-0') as { metadata: string }).metadata).toBe('{bad');
      expect(getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeTruthy();
    });
  });

  describe('what a week the backfill could not mark still counts', () => {
    it('adds the commits its summary declared to the total, but not to hours, days or sessions', () => {
      oldW10(25);
      forget({ name: 'c-0' });
      compressAt('2026-03-19T12:00:00.000Z');
      asLegacy();
      backfillCompressionMarkers(getDatabase());
      expect(markedCount()).toBe(0);
      expect(totalCommits()).toBe(24);
      const schedule = computePatterns(getDatabase(), ['workSchedule']).workSchedule;
      expect(schedule.hourDistribution.reduce((n, h) => n + h.count, 0)).toBe(0);
      expect(schedule.dayDistribution.reduce((n, d) => n + d.count, 0)).toBe(0);
    });

    it('does not count a commit twice once it is remembered again, and drops it when it is forgotten again', () => {
      // Known limit, not tested as correct: in data an older version wrote,
      // "compressed, remembered again, then forgotten" leaves the same row as
      // "compressed", so such a commit is still counted (marked, or in the
      // declared number) — nothing on the row tells the two apart.
      oldW10(25);
      commitAt('tail-0', '2026-03-13 10:00:00');
      forget({ name: 'c-0' });
      compressAt('2026-03-19T12:00:00.000Z');
      asLegacy();
      backfillCompressionMarkers(getDatabase());
      // 24 declared (none could be marked) + the active tail.
      expect(totalCommits()).toBe(25);
      remember({ name: 'c-3', type: 'commit', observations: ['fix: c-3'] });
      expect(totalCommits()).toBe(25);
      forget({ name: 'c-3' });
      expect(totalCommits()).toBe(24);
      // Remembered once more: it was already taken out of its week's number.
      remember({ name: 'c-3', type: 'commit', observations: ['fix: c-3'] });
      expect(totalCommits()).toBe(25);
      // The tail was never compressed, so it never was in that number.
      forget({ name: 'tail-0' });
      remember({ name: 'tail-0', type: 'commit', observations: ['fix: tail-0'] });
      expect(totalCommits()).toBe(25);
    });
  });

  describe('compression and the marker', () => {
    it('drops the marker when an archived record is remembered again, so forgetting it later takes it out', () => {
      oldW10(25);
      compressAt('2026-03-19T12:00:00.000Z');
      expect(totalCommits()).toBe(25);
      remember({ name: 'c-1', type: 'commit', observations: ['fix: c-1'] });
      expect(markerOf('c-1')).toBeNull();
      forget({ name: 'c-1' });
      expect(totalCommits()).toBe(24);
    });

    it('compresses rows whose metadata is not an object without rewriting it (JSON null aside)', () => {
      oldW10(25);
      const set = getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?');
      const values = ['null', '5', '"x"', '[1]', '{bad'];
      values.forEach((value, i) => set.run(value, `c-${i}`));
      expect(() => compressAt('2026-03-19T12:00:00.000Z')).not.toThrow();
      expect(['c-0', 'c-1', 'c-2', 'c-3', 'c-4'].map(statusOf)).toEqual(Array(5).fill('archived'));
      expect(markerOf('c-0')).toBe(summaryId('2026-W10'));
      const metaOf = (name: string) => String((getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(name) as { metadata: unknown }).metadata);
      expect(['c-1', 'c-2', 'c-3', 'c-4'].map(metaOf)).toEqual(values.slice(1));
    });

    it('names a week as SQLite %W does, Monday first: a Sunday belongs to the week before', () => {
      // 2026-03-15 is a Sunday: %W puts it in 2026-W10, %U would say 2026-W11.
      // Summaries written by earlier versions carry this name, and the backfill finds them by it.
      for (let i = 0; i < 25; i++) commitAt(`sun-${i}`, `2026-03-15 ${String(8 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`);
      compressAt('2026-03-26T12:00:00.000Z');
      expect(markerOf('sun-0')).toBe(summaryId('2026-W10'));
    });
  });

  describe('when it runs, and what it says', () => {
    it('on a fresh database: no backup folder, done, and no line about marking nothing', () => {
      closeDatabase();
      for (const file of [handle.dbPath, `${handle.dbPath}-wal`, `${handle.dbPath}-shm`]) fs.rmSync(file, { force: true });
      const stderr = captureStderr();
      try {
        openDatabase(handle.dbPath);
      } finally {
        stderr.restore();
      }
      expect(fs.existsSync(backupsDir())).toBe(false);
      expect((getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY) as { value: string }).value).toBe('1');
      expect(stderr.text()).not.toMatch(/marked 0 archived/);
    });

    it('says why when the backup cannot be made', () => {
      legacyCompressedWeek(25);
      fs.writeFileSync(backupsDir(), 'a file where the folder should be');
      const stderr = captureStderr();
      try {
        backfillCompressionMarkers(getDatabase());
      } finally {
        stderr.restore();
      }
      expect(stderr.text()).toMatch(/no backup could be made/);
    });

    it('once done, neither backs up nor marks rows that appear later', () => {
      legacyCompressedWeek(25);
      backfillCompressionMarkers(getDatabase());
      fs.rmSync(backupsDir(), { recursive: true, force: true });
      getDatabase().exec("UPDATE entities SET metadata = json_remove(metadata, '$.compacted_into') WHERE type = 'commit'");
      backfillCompressionMarkers(getDatabase());
      expect(markedCount()).toBe(0);
      expect(fs.existsSync(backupsDir())).toBe(false);
    });

    /** Three starts a minute apart (so each backup would get a name of its own) while a trigger refuses the marking with `message`. */
    function threeStartsRefused(message: string): string {
      legacyCompressedWeek(25);
      getDatabase().exec(`CREATE TRIGGER refuse_marking BEFORE UPDATE OF metadata ON entities BEGIN SELECT RAISE(ABORT, '${message}'); END`);
      const stderr = captureStderr();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        for (let minute = 0; minute < 3; minute++) {
          vi.setSystemTime(Date.UTC(2026, 10, 11, 12, minute));
          backfillCompressionMarkers(getDatabase());
        }
      } finally {
        vi.useRealTimers();
        stderr.restore();
      }
      expect(getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(KEY)).toBeUndefined();
      return stderr.text();
    }

    it('leaves no backup behind, and makes none on later starts, while a failed run waits out its retry delay', () => {
      const text = threeStartsRefused('refused by test');
      expect(text).toMatch(/refused by test/);
      expect(text.match(/backed up the database/g) ?? []).toHaveLength(1);
      expect(text).toMatch(/the marking did not happen/);
      expect(finalBackups()).toEqual([]);
    });

    it('leaves no backup behind when a held lock defers the marking itself, start after start', () => {
      const text = threeStartsRefused('database is locked');
      expect(text).toMatch(/deferred/);
      expect(finalBackups()).toEqual([]);
      getDatabase().exec('DROP TRIGGER refuse_marking');
      backfillCompressionMarkers(getDatabase());
      expect(finalBackups()).toHaveLength(1);
      expect(totalCommits()).toBe(25);
    });

    it('writes its copy under a temporary name, renamed only when complete', () => {
      legacyCompressedWeek(25);
      const db = getDatabase();
      const prepare = db.prepare.bind(db);
      const targets: unknown[] = [];
      const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        const statement = prepare(sql);
        if (!sql.startsWith('VACUUM INTO')) return statement;
        return { run: (...args: unknown[]) => { targets.push(args[0]); return (statement.run as (...a: unknown[]) => unknown)(...args); } };
      }) as never);
      try {
        backfillCompressionMarkers(db);
      } finally {
        spy.mockRestore();
      }
      expect(targets).toHaveLength(1);
      expect(String(targets[0])).toMatch(/\.db\.tmp$/);
      expect(finalBackups()).toEqual([path.basename(String(targets[0]), '.tmp')]);
    });

    it('releases only its own claim: one taken over meanwhile stays with its new holder', () => {
      legacyCompressedWeek(25);
      const leaseKey = `${KEY}_lease`;
      const other = `424242:${Date.now() + 600_000}`;
      // While the marking runs, another process takes the claim over.
      getDatabase().exec(`CREATE TRIGGER take_over AFTER UPDATE OF metadata ON entities BEGIN UPDATE memesh_metadata SET value = '${other}' WHERE key = '${leaseKey}'; END`);
      backfillCompressionMarkers(getDatabase());
      getDatabase().exec('DROP TRIGGER take_over');
      expect(totalCommits()).toBe(25);
      expect((getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(leaseKey) as { value: string } | undefined)?.value).toBe(other);
    });
  });
});

/** Collect what is written to stderr until `restore()`. */
function captureStderr(): { text: () => string; restore: () => void } {
  let text = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as never);
  return { text: () => text, restore: () => spy.mockRestore() };
}
