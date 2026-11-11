/**
 * A database whose file opens fine but whose message-table pages are damaged.
 * Briefing used to say nothing, then said "run memesh doctor" while doctor
 * called the database healthy. Both are checked here against a real damaged
 * file, not a stub.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { damagedDatabaseFix, damagedDatabaseSteps, diagnoseDatabaseFailure } from '../../src/core/database-diagnosis.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { recall, remember } from '../../src/core/operations.js';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const handle = useTestDatabase('memesh-db-corruption-');

/** Write garbage over the root page of the deliveries table, then reopen the file. */
function damageDeliveriesTable(): void {
  const db = getDatabase();
  const { rootpage } = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'agent_message_deliveries'").get() as { rootpage: number };
  const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number };
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  closeDatabase();
  const fd = fs.openSync(handle.dbPath, 'r+');
  try {
    fs.writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, (rootpage - 1) * pageSize);
  } finally {
    fs.closeSync(fd);
  }
  openDatabase(handle.dbPath);
}

/** Doctor resolves the database path from the environment, so point it at the file the test damaged. */
async function doctor() {
  const previous = process.env.MEMESH_DB_PATH;
  process.env.MEMESH_DB_PATH = handle.dbPath;
  try {
    return await runDoctorOnce();
  } finally {
    if (previous === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = previous;
  }
}

function runDoctorOnce() {
  return runDoctor({
    packageRoot: process.cwd(),
    packageVersion: 'test',
    openDatabaseImpl: () => getDatabase(),
    closeDatabaseImpl: () => undefined,
    isDatabaseOpenImpl: () => true,
    getConfigPathImpl: () => path.join(handle.tmpDir, 'config.json'),
    getUpdateCheckImpl: async () => ({ checkSucceeded: true, updateAvailable: false }) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({ label: 'npm global', canSelfUpdate: false }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
}

const send = () => sendAgentMessage(getDatabase(), {
  project: 'proj-c', sender: 'sender', recipient: 'reader', idempotency_key: 'c-1',
  content_type: 'application/json', payload: { text: 'hello' },
});

describe('a database with damaged pages', () => {

  it('is a healthy file to start with: doctor passes and briefing counts the message', async () => {
    send();
    const report = await doctor();
    expect(report.checks.find((c) => c.id === 'database')?.status).toBe('pass');
    expect(assembleBriefing('proj-c', 'reader').text).toContain('1 message waiting');
  });

  it('makes doctor fail the database row, naming the damage and how to restore', async () => {
    send();
    damageDeliveriesTable();
    const report = await doctor();
    const rows = report.checks.filter((c) => c.id === 'database');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('fail');
    expect(rows[0].summary).toContain('quick integrity check failed');
    // The row names the file that is actually damaged, and the advice starts by copying it.
    expect(rows[0].summary).toContain(handle.dbPath);
    expect(rows[0].fix).toContain(damagedDatabaseSteps(handle.dbPath).copy);
    expect(rows[0].fix).toMatch(/\.recover \| sqlite3 /);
    // No backups folder beside this file: no restore is offered.
    expect(rows[0].fix).not.toMatch(/backup instead/);
    expect(report.status).toBe('FAIL');
  });

  it('makes briefing carry SQLite\'s own error, so "run memesh doctor" leads somewhere', () => {
    send();
    damageDeliveriesTable();
    const text = assembleBriefing('proj-c', 'reader').text;
    expect(text).toContain('could not be read: "');
    expect(text).toMatch(/malformed/i);
    expect(text).toContain('run memesh doctor');
  });
});

describe('a database whose message table lacks a column this version reads', () => {
  it('fails the doctor database row too, so the briefing\'s "run memesh doctor" leads somewhere', async () => {
    send();
    getDatabase().exec('ALTER TABLE agent_message_receipts RENAME COLUMN receipt_kind TO renamed_kind');
    expect(assembleBriefing('proj-c', 'reader').text).toContain('could not be read: "no such column');
    const rows = (await doctor()).checks.filter((c) => c.id === 'database');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('fail');
    expect(rows[0].summary).toContain('message inbox cannot be read: no such column');
    expect(rows[0].fix).toMatch(/cannot read the message tables/);
  });
});

/** Fold the journal in, cut the file in half, and return the fix for the error opening it raises. */
function truncateAndDiagnose(): string {
  getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  closeDatabase();
  fs.truncateSync(handle.dbPath, Math.floor(fs.statSync(handle.dbPath).size / 2));
  try {
    openDatabase(handle.dbPath);
  } catch (err) {
    return diagnoseDatabaseFailure(err, handle.dbPath).fix;
  }
  throw new Error('a file cut in half still opened');
}

describe('the repair advice, as text', () => {
  it('gives a truncated file the copy-first advice, never "move it aside"', () => {
    remember({ name: 'trunc-0', type: 'note', observations: ['x'] });
    const fix = truncateAndDiagnose();
    expect(fix).toMatch(/^Stop every memesh process, then copy the damaged file/);
    expect(fix).toContain(damagedDatabaseSteps(handle.dbPath).copy);
    expect(fix).not.toMatch(/mv .*\.backup/);
  });

  it('offers no restore when the backups folder holds no complete copy', () => {
    const backups = path.join(path.dirname(handle.dbPath), 'backups');
    fs.mkdirSync(backups, { recursive: true });
    expect(damagedDatabaseSteps(handle.dbPath).restore).toBeUndefined();
    fs.writeFileSync(path.join(backups, 'before-y.db.tmp'), 'half a backup');
    fs.writeFileSync(path.join(backups, 'empty.db'), '');
    fs.mkdirSync(path.join(backups, 'folder.db'));
    expect(damagedDatabaseFix(handle.dbPath)).not.toMatch(/backup instead/);
  });

  describe('which files in backups/ count as a backup of the memory database', () => {
    const backupsDir = () => {
      const dir = path.join(path.dirname(handle.dbPath), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const put = (name: string, mtimeSeconds: number) => {
      const file = path.join(backupsDir(), name);
      fs.writeFileSync(file, 'a file with some bytes in it');
      fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
      return file;
    };

    it('never offers the expired-message archive as a backup to restore', () => {
      put('agent-messages-expired.db', 2_000_000);
      put('agent-messages-expired-other.db', 2_000_100);
      expect(damagedDatabaseSteps(handle.dbPath).restore).toBeUndefined();
      expect(damagedDatabaseFix(handle.dbPath)).not.toMatch(/backup instead/);
      expect(damagedDatabaseFix(handle.dbPath)).not.toContain('agent-messages-expired');
    });

    it('picks the real backup even when the expired-message archive is newer', () => {
      const real = put('pre-update-4.12.0-2026-11-12T00-00-00-000Z.db', 1_000_000);
      put('agent-messages-expired.db', 2_000_000);
      expect(damagedDatabaseSteps(handle.dbPath).restore).toContain(real);
      expect(damagedDatabaseFix(handle.dbPath)).not.toContain('agent-messages-expired');
    });

    it.each([
      'pre-update-4.12.0-2026-11-12T00-00-00-000Z.db',
      'before-compression-marker-2026-11-12T00-00-00-000Z.db',
      'kg-before-rename-project-2026-11-12T00-00-00-000Z.db',
      'knowledge-graph-before-note-trust-2026-11-12T00-00-00-000Z-0123abcd.db',
    ])('a file named like the ones the product writes (%s) is a backup', (name) => {
      const file = put(name, 1_000_000);
      expect(damagedDatabaseSteps(handle.dbPath).restore).toContain(file);
    });
  });
});

// The printed repair, run as printed: each step goes through `sh -c` exactly as
// it appears in the fix text, against real SQLite files.
const canRunSteps = process.platform !== 'win32'
  && spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!canRunSteps)('the repair advice, run as printed', () => {
  /** A `memesh` on PATH that is the built CLI, so `memesh reindex --fts` in the advice runs. */
  function shellEnv(dbPath: string): NodeJS.ProcessEnv {
    const bin = path.join(handle.tmpDir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'memesh');
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('dist/transports/cli/cli.js'))} "$@"\n`, { mode: 0o755 });
    const home = path.join(handle.tmpDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, MEMESH_DB_PATH: dbPath, MEMESH_DIR: path.dirname(dbPath) };
  }

  function run(command: string, env: NodeJS.ProcessEnv): void {
    const result = spawnSync('sh', ['-c', command], { env, encoding: 'utf8' });
    expect(result.status, `${command}\n${result.stderr}`).toBe(0);
  }

  /** Every step of the fix, checked to appear verbatim in the printed text, then run. */
  function repair(dbPath: string, fix: string, which: Array<'copy' | 'restore' | 'salvage' | 'replace'>): void {
    const steps = damagedDatabaseSteps(dbPath);
    const env = shellEnv(dbPath);
    for (const name of which) {
      const command = steps[name];
      expect(command, `the advice has a ${name} step`).toBeTypeOf('string');
      expect(fix).toContain(command as string);
      run(command as string, env);
    }
  }

  const withFile = <T>(dbPath: string, read: (db: MemeshDatabase) => T): T => {
    const db = new MemeshDatabase(dbPath);
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  const quickCheck = (dbPath: string) => withFile(dbPath, (db) => (db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string }).quick_check);
  const entityNames = (dbPath: string, like: string) => withFile(dbPath, (db) =>
    (db.prepare('SELECT name FROM entities WHERE name LIKE ? ORDER BY name').all(like) as Array<{ name: string }>).map((r) => r.name));

  function seed(prefix: string, n: number): void {
    for (let i = 0; i < n; i++) remember({ name: `${prefix}-${i}`, type: 'note', observations: [`checkpoint number ${i} for ${prefix}`] });
  }

  it('salvages a file with a damaged page, and keyword search works afterwards', async () => {
    seed('page', 20);
    send();
    damageDeliveriesTable();
    const fix = (await doctor()).checks.find((c) => c.id === 'database')?.fix ?? '';
    closeDatabase();
    repair(handle.dbPath, fix, ['copy', 'salvage', 'replace']);
    expect(quickCheck(handle.dbPath)).toBe('ok');
    expect(entityNames(handle.dbPath, 'page-%')).toHaveLength(20);
    openDatabase(handle.dbPath);
    expect(recall({ query: 'checkpoint number 7 page' }).map((e) => e.name)).toContain('page-7');
  });

  it('leaves a truncated file as a database that opens and passes its check', () => {
    seed('trunc', 20);
    const fix = truncateAndDiagnose();
    repair(handle.dbPath, fix, ['copy', 'salvage', 'replace']);
    expect(quickCheck(handle.dbPath)).toBe('ok');
    openDatabase(handle.dbPath);
  });

  it('keeps writes still in the -wal journal, in a folder whose name has a quote and a space', () => {
    // Copied while the live database is open, so the copy carries a -wal
    // SQLite has not folded into the file yet: the newest writes live only there.
    getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed('wal', 30);
    const dir = path.join(handle.tmpDir, "it's here");
    fs.mkdirSync(dir);
    const copyPath = path.join(dir, 'knowledge-graph.db');
    for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(`${handle.dbPath}${suffix}`, `${copyPath}${suffix}`);
    expect(fs.statSync(`${copyPath}-wal`).size).toBeGreaterThan(0);
    // Damage a page only the main file holds: the deliveries table, untouched since the checkpoint.
    const db = getDatabase();
    const { rootpage } = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'agent_message_deliveries'").get() as { rootpage: number };
    const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number };
    const fd = fs.openSync(copyPath, 'r+');
    try {
      fs.writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, (rootpage - 1) * pageSize);
    } finally {
      fs.closeSync(fd);
    }
    repair(copyPath, damagedDatabaseFix(copyPath), ['copy', 'salvage', 'replace']);
    expect(quickCheck(copyPath)).toBe('ok');
    expect(entityNames(copyPath, 'wal-%')).toHaveLength(30);
  });

  it('rebuilds a keyword index the salvage could not bring back', () => {
    seed('fts', 20);
    const db = getDatabase();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number };
    const pages = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name IN ('entities_fts_data', 'entities_fts_idx')").all() as Array<{ rootpage: number }>).map((r) => r.rootpage);
    closeDatabase();
    const fd = fs.openSync(handle.dbPath, 'r+');
    try {
      for (const page of pages) fs.writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, (page - 1) * pageSize);
    } finally {
      fs.closeSync(fd);
    }
    repair(handle.dbPath, damagedDatabaseFix(handle.dbPath), ['copy', 'salvage', 'replace']);
    openDatabase(handle.dbPath);
    expect(recall({ query: 'checkpoint number 7 fts' }).map((e) => e.name)).toContain('fts-7');
  });

  it('restores the newest complete backup, over a stale journal', () => {
    seed('kept', 5);
    getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const backups = path.join(path.dirname(handle.dbPath), 'backups');
    fs.mkdirSync(backups, { recursive: true });
    getDatabase().prepare('VACUUM INTO ?').run(path.join(backups, 'kg-before-restore-test-2026-11-12T00-00-00-000Z.db'));
    fs.writeFileSync(path.join(backups, 'before-y.db.tmp'), 'half a backup');
    // A real journal of the old file, left behind: replayed onto the restored
    // copy it would write the old file's pages into it.
    seed('lost', 40);
    const staleJournal = path.join(handle.tmpDir, 'stale-wal');
    fs.copyFileSync(`${handle.dbPath}-wal`, staleJournal);
    closeDatabase();
    fs.writeFileSync(handle.dbPath, 'not a database any more');
    fs.copyFileSync(staleJournal, `${handle.dbPath}-wal`);
    fs.rmSync(`${handle.dbPath}-shm`, { force: true });
    const fix = damagedDatabaseFix(handle.dbPath);
    expect(fix).toContain(path.join(backups, 'kg-before-restore-test-2026-11-12T00-00-00-000Z.db'));
    expect(fix).not.toContain('.restore');
    repair(handle.dbPath, fix, ['copy', 'restore']);
    expect(quickCheck(handle.dbPath)).toBe('ok');
    expect(entityNames(handle.dbPath, 'kept-%')).toHaveLength(5);
  });

});

describe('the MCP server on a database that will not open', () => {
  it('prints the same diagnosis and fix as serve, on stderr, and leaves stdout to the protocol', () => {
    closeDatabase();
    fs.writeFileSync(handle.dbPath, Buffer.alloc(8192, 0xa5));
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${handle.dbPath}${suffix}`, { force: true });
    const home = path.join(handle.tmpDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const result = spawnSync(process.execPath, [path.resolve('dist/mcp/server.js')], {
      env: { ...process.env, HOME: home, MEMESH_DB_PATH: handle.dbPath, MEMESH_DIR: handle.tmpDir },
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MeMesh startup failed: database cannot be opened');
    expect(result.stderr).toContain(`Database path: ${handle.dbPath}`);
    expect(result.stderr).toContain(`Fix: ${diagnoseDatabaseFailure(new Error('file is not a database'), handle.dbPath).fix}`);
  });

  it('names a database path whose folder is a file, with the same fix as serve and doctor, not a reset', () => {
    const blockingFile = path.join(handle.tmpDir, 'iamafile.txt');
    fs.writeFileSync(blockingFile, 'I am a regular file, not a directory.');
    const home = path.join(handle.tmpDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const result = spawnSync(process.execPath, [path.resolve('dist/mcp/server.js')], {
      env: { ...process.env, HOME: home, MEMESH_DB_PATH: path.join(blockingFile, 'cannot-write-here.db'), MEMESH_DIR: handle.tmpDir },
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`${blockingFile} is a file, not a folder`);
    expect(result.stderr).toContain('Fix: Point MEMESH_DB_PATH at a path inside a folder');
    expect(result.stderr).not.toMatch(/Backup and reset|mv /);
  });
});
