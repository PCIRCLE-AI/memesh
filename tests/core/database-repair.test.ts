import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { recall, remember } from '../../src/core/operations.js';
import { repairDatabase, usableMemoryBackups } from '../../src/core/database-repair.js';
import { repairCommand } from '../../src/core/database-diagnosis.js';
import * as windowsGuard from '../../src/core/windows-repair-guard.js';
import { registerLiveHost, updateControlDir } from '../../src/core/auto-update.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { installLegacyMessageSchema } from '../helpers/agent-session-fixture.js';

const fixture = useTestDatabase('memesh-database-repair-');
const missingSqlite = () => path.join(fixture.tmpDir, 'sqlite3-not-installed');
const digest = (file: string) => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const bytes = () => ['', '-wal'].map(suffix => digest(fixture.dbPath + suffix));
const familyBytes = () => [...bytes(), digest(fixture.dbPath + '-shm')];
function seed(n = 20) {
  for (let i = 0; i < n; i++) remember({ name: `kept-${i}`, type: 'note', observations: [`repair keyword marker ${i}`] });
}
function damage(table: string) {
  const db = getDatabase();
  if (table === 'agent_message_deliveries') installLegacyMessageSchema(db);
  const row = db.prepare('SELECT rootpage FROM sqlite_master WHERE name=?').get(table) as { rootpage: number };
  const { page_size: page } = db.prepare('PRAGMA page_size').get() as { page_size: number };
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  closeDatabase();
  const fd = fs.openSync(fixture.dbPath, 'r+');
  try { fs.writeSync(fd, Buffer.alloc(page, 0xa5), 0, page, (row.rootpage - 1) * page); }
  finally { fs.closeSync(fd); }
}
function inspect() {
  const db = new MemeshDatabase(fixture.dbPath, { readOnly: true });
  try { return { quick: db.prepare('PRAGMA quick_check').get(), count: db.prepare('SELECT COUNT(*) AS n FROM entities').get() }; }
  finally { db.close(); }
}
function commitWalAndCrash(file: string, sql: string): void {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec(process.argv[2]);
    writeSync(1, 'committed\\n');
    process.kill(process.pid, 'SIGKILL');
    process.exit(70);
  `, file, sql], { encoding: 'utf8', timeout: 5000 });
  expect(child.error).toBeUndefined();
  expect(child.stdout, child.stderr).toBe('committed\n');
  // Windows libuv terminates with code 1 when the fixture kills itself.
  expect(child.status).toBe(process.platform === 'win32' ? 1 : null);
  expect(child.signal).toBe(process.platform === 'win32' ? null : 'SIGKILL');
  expect(fs.statSync(file + '-wal').size).toBeGreaterThan(32);
}
function pendingWal(corrupt = true): void {
  seed();
  const db = getDatabase();
  installLegacyMessageSchema(db);
  const row = db.prepare("SELECT rootpage FROM sqlite_master WHERE name='agent_message_deliveries'").get() as { rootpage: number };
  const page = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  closeDatabase();
  commitWalAndCrash(fixture.dbPath,
    "PRAGMA journal_mode=WAL; INSERT INTO entities(name,type) VALUES ('wal-only','note'); INSERT INTO observations(entity_id,content) SELECT id,'wal recovery token' FROM entities WHERE name='wal-only';");
  expect(fs.readFileSync(fixture.dbPath).includes('wal-only')).toBe(false);
  if (!corrupt) return;
  const fd = fs.openSync(fixture.dbPath, 'r+');
  try { fs.writeSync(fd, Buffer.alloc(page, 0xa5), 0, page, (row.rootpage - 1) * page); }
  finally { fs.closeSync(fd); }
}

describe('one-command database repair', () => {
  it('a damaged header checks HOME host registration before replacing a database elsewhere', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(fixture.tmpDir, 'home');
    try {
      seed(); getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)'); closeDatabase();
      const backup = path.join(fixture.tmpDir, 'safe-backup.db'); fs.copyFileSync(fixture.dbPath, backup);
      const file = fs.openSync(fixture.dbPath, 'r+');
      try { fs.writeSync(file, Buffer.alloc(100, 0xa5), 0, 100, 0); } finally { fs.closeSync(file); }
      registerLiveHost(updateControlDir(), process.pid);
      const before = bytes();
      await expect(repairDatabase(fixture.dbPath, { fromBackup: backup })).rejects.toThrow(/Close every AI tool/);
      expect(bytes()).toEqual(before);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });

  it('does nothing to a healthy database', async () => {
    seed(); closeDatabase();
    const before = bytes();
    await expect(repairDatabase(fixture.dbPath, { sqliteExecutable: missingSqlite() })).resolves.toEqual({ status: 'healthy' });
    expect(bytes()).toEqual(before);
  });
  it.skipIf(process.platform === 'win32').each([
    { empty: false, mode: 0o400, refused: false },
    { empty: true, mode: 0o400, refused: true },
    { empty: true, mode: 0o600, refused: false },
  ])('preserves committed WAL with empty=$empty sidecar mode=$mode', async ({ empty, mode, refused }) => {
    pendingWal(false);
    const file = fixture.dbPath;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file + '-wal').size).toBeGreaterThan(32);
    expect(fs.statSync(file + '-shm').size).toBeGreaterThan(0);
    if (empty) fs.truncateSync(file + '-shm', 0);
    for (const suffix of ['-wal', '-shm']) fs.chmodSync(file + suffix, mode);
    const family = () => ['', '-wal', '-shm'].map(suffix => ({
      mode: fs.statSync(file + suffix).mode & 0o777,
      bytes: fs.readFileSync(file + suffix),
    }));
    const before = family();
    const namesBefore = fs.readdirSync(fixture.tmpDir).sort();
    if (refused) {
      await expect(repairDatabase(file, { sqliteExecutable: missingSqlite() })).rejects.toThrow(/fewer owner permissions/);
      expect(fs.readdirSync(fixture.tmpDir).sort()).toEqual(namesBefore);
    } else await expect(repairDatabase(file)).resolves.toEqual({ status: 'healthy' });
    const after = family();
    if (mode === 0o400) expect(after).toEqual(before);
    else {
      expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
      expect(after[2].mode).toBe(0o600);
    }
    // Read a disposable clone, never reopen the measured original to check data.
    const copy = path.join(fixture.tmpDir, 'wal-check.db');
    for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(file + suffix, copy + suffix, fs.constants.COPYFILE_EXCL);
    const db = new MemeshDatabase(copy, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM entities').get()).toMatchObject({ n: 21 });
      expect(db.prepare("SELECT content FROM observations JOIN entities ON entities.id=observations.entity_id WHERE entities.name='wal-only'").get()).toMatchObject({ content: 'wal recovery token' });
    } finally { db.close(); }
  });
  it.skipIf(process.platform === 'win32')('refuses empty owner-mismatched sidecars before the fromBackup writable replacement lock', async () => {
    pendingWal(false);
    const file = fixture.dbPath;
    const backup = path.join(fixture.tmpDir, 'standalone-backup.db');
    // The checkpointed main has 20 memories; the last committed memory is only in WAL.
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    const backupDb = new MemeshDatabase(backup, { readOnly: true });
    try {
      expect(backupDb.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' });
      expect(backupDb.prepare('SELECT COUNT(*) AS n FROM entities').get()).toMatchObject({ n: 20 });
    } finally { backupDb.close(); }
    fs.truncateSync(file + '-shm', 0);
    for (const suffix of ['-wal', '-shm']) fs.chmodSync(file + suffix, 0o400);
    const family = () => ['', '-wal', '-shm'].map(suffix => ({
      mode: fs.statSync(file + suffix).mode & 0o777,
      bytes: fs.readFileSync(file + suffix),
    }));
    const before = family();
    const replace = vi.fn();
    await expect(repairDatabase(file, { fromBackup: backup, replaceFile: replace })).rejects.toThrow(/fewer owner permissions/);
    expect(replace).not.toHaveBeenCalled();
    expect(family()).toEqual(before);
    // Damaged-copy artifacts are allowed; the original must retain the WAL-only memory.
    const copy = path.join(fixture.tmpDir, 'replacement-check.db');
    for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(file + suffix, copy + suffix, fs.constants.COPYFILE_EXCL);
    const db = new MemeshDatabase(copy, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM entities').get()).toMatchObject({ n: 21 });
      expect(db.prepare("SELECT content FROM observations JOIN entities ON entities.id=observations.entity_id WHERE entities.name='wal-only'").get()).toMatchObject({ content: 'wal recovery token' });
    } finally { db.close(); }
  });
  it('uses the built-in fallback without sqlite3 and preserves all 20 readable memories', async () => {
    seed(); damage('agent_message_deliveries');
    const before = bytes();
    const result = await repairDatabase(fixture.dbPath, { sqliteExecutable: missingSqlite() });
    expect(result).toMatchObject({ status: 'repaired', method: 'built-in' });
    expect(digest(result.damagedCopy!)).toBe(before[0]);
    expect(inspect()).toMatchObject({ quick: { quick_check: 'ok' }, count: { n: 20 } });
    expect(result.tables?.find(table => table.name === 'agent_message_deliveries')?.complete).toBe(false);
    openDatabase(fixture.dbPath);
    expect(recall({ query: 'repair keyword marker 7' }).some(row => row.name === 'kept-7')).toBe(true);
  });
  it('falls back when a system executable cannot run recovery', async () => {
    seed(); damage('agent_message_deliveries');
    // Node is present but rejects sqlite3's arguments: a real failed child, not a stubbed status.
    const result = await repairDatabase(fixture.dbPath, { sqliteExecutable: process.execPath });
    expect(result.method).toBe('built-in');
    expect(result.reason).toBeTruthy();
    expect(inspect().count).toMatchObject({ n: 20 });
  });
  it('refuses an empty salvage of an unreadable memory root and leaves original bytes untouched', async () => {
    seed(); damage('entities');
    const before = bytes();
    let message = '';
    try { await repairDatabase(fixture.dbPath, { sqliteExecutable: missingSqlite() }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('memory table could not be recovered');
    expect(message).toContain('No usable memory backup is available');
    expect(bytes()).toEqual(before);
  });
  it('stops at a held exclusive lock without replacing the file', async () => {
    seed(); damage('agent_message_deliveries');
    const lock = new MemeshDatabase(fixture.dbPath);
    lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    const before = bytes();
    try {
      await expect(repairDatabase(fixture.dbPath, { sqliteExecutable: missingSqlite() })).rejects.toThrow(/database is locked|Cannot acquire the Windows repair lock/);
      expect(bytes()).toEqual(before);
    } finally { lock.exec('ROLLBACK'); lock.close(); }
  });
  it.runIf(process.platform === 'win32')('does not modify the original family if guard acquisition or capability preflight fails', async () => {
    pendingWal(false);
    const backup = path.join(fixture.tmpDir, 'verified-backup.db');
    fs.copyFileSync(fixture.dbPath, backup);
    const replace = vi.fn();
    const reader = new MemeshDatabase(fixture.dbPath, { readOnly: true });
    try {
      expect(reader.prepare('SELECT COUNT(*) AS n FROM entities').get()).toMatchObject({ n: 21 });
      const before = familyBytes();
      await expect(repairDatabase(fixture.dbPath, { fromBackup: backup, replaceFile: replace })).rejects.toThrow('Cannot acquire the Windows repair lock');
      expect(familyBytes()).toEqual(before);
    } finally { reader.close(); }

    const before = familyBytes();
    const open = fs.openSync;
    const unlink = fs.unlinkSync;
    let attemptedUnlink = false;
    const remove = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file).endsWith('.guard-unlink')) attemptedUnlink = true;
      return unlink(file);
    });
    const deny = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (attemptedUnlink && String(file).endsWith('.guard-unlink') && flags === 'wx') throw new Error('injected delete-pending name');
      return open(file, flags, mode);
    });
    try {
      await expect(repairDatabase(fixture.dbPath, { fromBackup: backup, replaceFile: replace })).rejects.toThrow('does not release guarded Windows journal paths on unlink');
      expect(familyBytes()).toEqual(before);
      expect(replace).not.toHaveBeenCalled();
    } finally { deny.mockRestore(); remove.mockRestore(); }
    expect(inspect().count).toMatchObject({ n: 21 });
  });
  it('restores exact bytes when final replacement fails', async () => {
    seed(); damage('agent_message_deliveries');
    const before = bytes();
    await expect(repairDatabase(fixture.dbPath, { sqliteExecutable: missingSqlite(), replaceFile: () => { throw new Error('rename fixture failed'); } })).rejects.toThrow('rename fixture failed');
    expect(bytes()).toEqual(before);
  });
  it('recovers the newest memory held only in a real WAL', async () => {
    pendingWal();
    const before = bytes();
    const result = await repairDatabase(fixture.dbPath, { sqliteExecutable: missingSqlite() });
    expect(result.method).toBe('built-in');
    expect(inspect().count).toMatchObject({ n: 21 });
    expect(digest(result.damagedCopy!)).toBe(before[0]);
    expect(digest(`${result.damagedCopy!}-wal`)).toBe(before[1]);
    openDatabase(fixture.dbPath);
    expect(recall({ query: 'wal recovery token' }).some(row => row.name === 'wal-only')).toBe(true);
  });
  it('restores both original and nonempty WAL byte-for-byte after a replacement failure', async () => {
    pendingWal();
    const before = bytes();
    await expect(repairDatabase(fixture.dbPath, { sqliteExecutable: missingSqlite(), replaceFile: () => { throw new Error('rename WAL fixture failed'); } })).rejects.toThrow('rename WAL fixture failed');
    expect(bytes()).toEqual(before);
  });
  it.runIf(process.platform === 'win32').each([false, true])('restores the Windows family byte-for-byte with empty SHM=%s', async (empty) => {
    pendingWal(false);
    const backup = path.join(fixture.tmpDir, 'verified-backup.db');
    fs.copyFileSync(fixture.dbPath, backup);
    const shm = fixture.dbPath + '-shm';
    if (empty) fs.truncateSync(shm, 0);
    const readFamily = () => ['', '-wal', '-shm'].map(suffix => fs.readFileSync(fixture.dbPath + suffix));
    const before = readFamily();
    expect(before[1].length).toBeGreaterThan(32);
    if (empty) expect(before[2].length).toBe(0);
    else expect(before[2].length).toBeGreaterThan(0);
    await expect(repairDatabase(fixture.dbPath, {
      fromBackup: backup,
      replaceFile: (_from, to) => {
        expect(digest(to + '-wal')).toBeNull();
        expect(digest(to + '-shm')).toBeNull();
        throw new Error('pre-commit callback');
      },
    })).rejects.toThrow('pre-commit callback');
    expect(readFamily()).toEqual(before);
    expect(inspect().count).toMatchObject({ n: 21 });
  });
  it('selects backups by contents and restores without moving the backup', async () => {
    seed(5);
    const dir = path.join(fixture.tmpDir, 'backups'); fs.mkdirSync(dir);
    const backup = path.join(dir, 'arbitrary-filename');
    getDatabase().prepare('VACUUM INTO ?').run(backup);
    const archive = new MemeshDatabase(path.join(dir, 'agent-messages-expired.db'));
    archive.exec('CREATE TABLE archive_log (body TEXT)'); archive.close();
    fs.writeFileSync(path.join(dir, 'pre-update-looking-but-invalid.db'), 'not a database');
    seed(20);
    damage('agent_message_deliveries');
    const beforeBackup = digest(backup);
    expect(usableMemoryBackups(fixture.dbPath).map(row => row.file)).toEqual([backup]);
    expect((await repairDatabase(fixture.dbPath, { fromBackup: true })).method).toBe('backup');
    expect(inspect().count).toMatchObject({ n: 5 });
    expect(digest(backup)).toBe(beforeBackup);
  });
  for (const fail of [false, true]) {
    it('blocks a real writer through final ' + (fail ? 'replacement failure' : 'replacement'), async () => {
      pendingWal();
      const before = bytes();
      let child: ReturnType<typeof spawnSync> | undefined;
      const repair = () => repairDatabase(fixture.dbPath, {
        sqliteExecutable: missingSqlite(),
        replaceFile: (_from, to, commit) => {
          child = spawnSync(process.execPath, ['--input-type=module','-e', `
            import { DatabaseSync } from 'node:sqlite';
            const db=new DatabaseSync(process.argv[1]);
            db.exec("PRAGMA busy_timeout=0; INSERT INTO entities(name,type) VALUES('racing-write','note')");
            db.close();
          `,to], { encoding:'utf8', timeout:5000 });
          if(fail) throw new Error('injected concurrent replacement failure');
          return commit();
        },
      });
      if(fail) {
        await expect(repair()).rejects.toThrow('injected concurrent replacement failure');
        expect(bytes()).toEqual(before);
      } else {
        expect((await repair()).status).toBe('repaired');
        expect(inspect().count).toMatchObject({n:21});
      }
      expect(child?.error).toBeUndefined();
      expect(child?.status).toBe(1);
      expect(String(child?.stderr)).toMatch(process.platform === 'win32' ? /unable to open database file/ : /database is locked/);
      // Once the repair releases its lock, an ordinary writer can commit.
      const after = spawnSync(process.execPath, ['--input-type=module','-e', `
        import { DatabaseSync } from 'node:sqlite';
        const db=new DatabaseSync(process.argv[1]);
        db.exec("INSERT INTO entities(name,type) VALUES('after-repair','note')");
        db.close();
      `, fixture.dbPath], { encoding:'utf8', timeout:5000 });
      expect(after.status, String(after.stderr)).toBe(0);
      const db=new MemeshDatabase(fixture.dbPath,{readOnly:true});
      try {
        expect(db.prepare("SELECT name FROM entities WHERE name='after-repair'").get()).toBeTruthy();
        expect(db.prepare("SELECT name FROM entities WHERE name='racing-write'").get()).toBeUndefined();
      }
      finally { db.close(); }
    });
  }
  const postCommitCases = process.platform === 'win32' ? ['none', 'callback', 'release'] : ['none', 'callback'];
  it.each(postCommitCases)('preserves replacement WAL with post-commit error=%s', async (failure) => {
    pendingWal();
    let committedWal: string | null = null;
    const acquire = windowsGuard.acquireWindowsRepairGuard;
    const spy = failure === 'release' ? vi.spyOn(windowsGuard, 'acquireWindowsRepairGuard').mockImplementation(async (...args) => {
      const guard = await acquire(...args);
      return { ...guard, async release() {
        await guard.release();
        throw new Error('injected post-commit release failure');
      } };
    }) : undefined;
    try {
      const repair = repairDatabase(fixture.dbPath, {
        sqliteExecutable: missingSqlite(),
        replaceFile: async (from, to, commit) => {
          // POSIX can also observe a rename completed outside the commit callback.
          if (failure === 'callback' && process.platform !== 'win32') fs.renameSync(from, to);
          else await commit();
          commitWalAndCrash(to, "PRAGMA journal_mode=WAL; INSERT INTO entities(name,type) VALUES('replacement-wal-write','note')");
          expect(fs.readFileSync(to).includes('replacement-wal-write')).toBe(false);
          committedWal = digest(to + '-wal');
          if (failure === 'callback') throw new Error('injected post-commit callback failure');
        },
      });
      if (failure === 'none') await expect(repair).resolves.toMatchObject({ status: 'repaired' });
      else await expect(repair).rejects.toThrow(`Database replacement completed before this error. injected post-commit ${failure} failure`);
    } finally { spy?.mockRestore(); }
    expect(committedWal).not.toBeNull();
    expect(digest(fixture.dbPath + '-wal')).toBe(committedWal);
    const db = new MemeshDatabase(fixture.dbPath, { readOnly: true });
    try { expect(db.prepare("SELECT name FROM entities WHERE name='replacement-wal-write'").get()).toBeTruthy(); }
    finally { db.close(); }
  });

  for (const explicit of [false,true]) {
    it('rejects an empty ' + (explicit ? 'explicit' : 'automatic') + ' backup over readable memories and WAL', async () => {
      const dir=path.join(fixture.tmpDir,'backups'); fs.mkdirSync(dir);
      const backup=path.join(dir,'empty-memory.db');
      getDatabase().prepare('VACUUM INTO ?').run(backup);
      pendingWal();
      const before=bytes();
      await expect(repairDatabase(fixture.dbPath,{fromBackup:explicit?backup:true})).rejects.toThrow(
        explicit ? 'memory table could not be recovered' : 'No usable memory backup');
      expect(bytes()).toEqual(before);
    });
  }
  it('permits an empty backup only when the source is verified intact and empty', async () => {
    const dir=path.join(fixture.tmpDir,'backups'); fs.mkdirSync(dir);
    const backup=path.join(dir,'empty-memory.db');
    getDatabase().prepare('VACUUM INTO ?').run(backup);
    closeDatabase();
    expect((await repairDatabase(fixture.dbPath, { fromBackup: true })).status).toBe('repaired');
    expect(inspect()).toMatchObject({quick:{quick_check:'ok'},count:{n:0}});
  });
  it('reports a verified backup and one restore command when the memory root cannot be salvaged', async () => {
    seed();
    const dir=path.join(fixture.tmpDir,'backups'); fs.mkdirSync(dir);
    const backup=path.join(dir,"usable backup's.db");
    getDatabase().prepare('VACUUM INTO ?').run(backup);
    const at=fs.statSync(backup).mtime.toISOString();
    damage('entities');
    const before=bytes();
    let message='';
    try { await repairDatabase(fixture.dbPath,{sqliteExecutable:missingSqlite()}); }
    catch(error) { message=(error as Error).message; }
    expect(message).toContain('memory table could not be recovered');
    expect(message).toContain(backup);
    expect(message).toContain(at);
    expect(message).toContain('20 memories');
    expect(message).toContain(repairCommand(fs.realpathSync(fixture.dbPath),fs.realpathSync(backup)));
    expect(message.match(/memesh repair/g)).toHaveLength(1);
    expect(bytes()).toEqual(before);
  });

  it('chooses the newest qualified backup when a newer empty backup is ineligible', async () => {
    const dir=path.join(fixture.tmpDir,'backups'); fs.mkdirSync(dir);
    const empty=path.join(dir,'new-empty.db');
    getDatabase().prepare('VACUUM INTO ?').run(empty);
    seed(5);
    const usable=path.join(dir,'older-five.db');
    getDatabase().prepare('VACUUM INTO ?').run(usable);
    fs.utimesSync(usable,new Date('2020-01-01'),new Date('2020-01-01'));
    fs.utimesSync(empty,new Date('2021-01-01'),new Date('2021-01-01'));
    seed(20); damage('agent_message_deliveries');
    expect((await repairDatabase(fixture.dbPath, { fromBackup: true })).status).toBe('repaired');
    expect(inspect().count).toMatchObject({n:5});
  });
  it('preserves a real writer commit made after the precheck but before lock acquisition', async () => {
    pendingWal();
    const original = MemeshDatabase.prototype.exec;
    const acquire = windowsGuard.acquireWindowsRepairGuard;
    let committed = false;
    const writeBeforeLock = () => {
      commitWalAndCrash(fixture.dbPath, "INSERT INTO entities(name,type) VALUES('before-lock-commit','note')");
      committed = true;
    };
    const spy = process.platform === 'win32'
      ? vi.spyOn(windowsGuard, 'acquireWindowsRepairGuard').mockImplementation((...args) => {
        writeBeforeLock();
        return acquire(...args);
      })
      : vi.spyOn(MemeshDatabase.prototype, 'exec').mockImplementation(function(this: MemeshDatabase, sql: string) {
        if (sql.includes('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;') && !committed) writeBeforeLock();
        return original.call(this, sql);
      });
    try {
      await expect(repairDatabase(fixture.dbPath,{sqliteExecutable:missingSqlite()})).rejects.toThrow('Database changed before the repair lock');
    } finally { spy.mockRestore(); }
    expect(committed).toBe(true);
    const db=new MemeshDatabase(fixture.dbPath,{readOnly:true});
    try { expect(db.prepare("SELECT name FROM entities WHERE name='before-lock-commit'").get()).toBeTruthy(); }
    finally { db.close(); }
  });

});
