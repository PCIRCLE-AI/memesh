/**
 * #520 on the hook side. Hooks run on every session and open the same data
 * folder and database as core, through their own code (`_shared.js`), so the
 * rule has to hold there too: other users lose access, the owner never gets
 * back a permission the owner removed, and a -wal/-shm SQLite would change is
 * refused with the owner's commands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, openDatabase } from '../../src/db.js';

const require = createRequire(import.meta.url);
// _shared.js is plain JS with no type declarations.
const shared = require('../../scripts/hooks/_shared.js');

const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0;
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe.skipIf(!posixUser)('#520: hooks and the data folder', () => {
  let home: string;
  let dataDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-perms-'));
    dataDir = path.join(home, '.memesh');
    fs.mkdirSync(dataDir, { mode: 0o700 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.chmodSync(dataDir, 0o700); } catch { /* gone */ }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function runSessionStart() {
    return spawnSync(process.execPath, [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ cwd: home }),
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: dataDir, MEMESH_DB_PATH: path.join(dataDir, 'knowledge-graph.db') },
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  it('a hook run leaves a read-only data folder read-only, and says why it could not record', () => {
    fs.chmodSync(dataDir, 0o555);
    const r = runSessionStart();
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0); // the hook really ran and answered
    expect(mode(dataDir)).toBe(0o500);
    expect(fs.existsSync(path.join(dataDir, 'hook-outcomes.jsonl'))).toBe(false);
    expect(r.stderr).toMatch(/could not record the session-start hook outcome/);
  });

  it('a hook run makes a world-readable data folder owner-only', () => {
    fs.chmodSync(dataDir, 0o755);
    const r = runSessionStart();
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0); // the hook really ran and answered
    expect(mode(dataDir)).toBe(0o700);
  });

  it('a ledger whose permissions cannot be tightened is reported, not skipped silently', () => {
    const ledger = path.join(dataDir, 'hook-outcomes.jsonl');
    fs.writeFileSync(ledger, '', { mode: 0o644 });
    fs.chmodSync(ledger, 0o644);
    const realChmod = fs.chmodSync;
    vi.spyOn(fs, 'chmodSync').mockImplementation((target, m) => {
      if (String(target) === ledger) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      realChmod(target, m);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // The ledger sits beside the database, which it finds through process.env.
    vi.stubEnv('MEMESH_DB_PATH', path.join(dataDir, 'knowledge-graph.db'));
    shared.recordHookOutcome(process.env, { hook: 'test-hook', outcome: 'skipped', reason: 'probe' });
    vi.unstubAllEnvs();
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain(ledger);
    expect(written).toContain('EPERM');
  });

  it('openHookDb: after only the database is restored, it refuses with the command for the -wal/-shm; after it, the write lands', () => {
    const dbPath = path.join(dataDir, 'knowledge-graph.db');
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    const env = { ...process.env, MEMESH_DB_PATH: dbPath };
    shared.openHookDb(env, { fts: true }).db.close();
    fs.chmodSync(dbPath, 0o444);
    // Any memesh process that opens the read-only database (here the CLI/MCP
    // path) leaves SQLite's -wal and -shm behind, owner read-only like it.
    openDatabase(dbPath).prepare('SELECT count(*) FROM entities').get();
    closeDatabase();
    expect(mode(wal) & 0o700).toBe(0o400);
    expect(mode(shm) & 0o700).toBe(0o400);

    // The hook's own read-only open names every file that needs write back.
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    shared.openHookDb(env, { fts: true }).db.close();
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain(`To write to it again, run: chmod u+w "${dbPath}" "${wal}" "${shm}"`);
    vi.restoreAllMocks();

    fs.chmodSync(dbPath, 0o600); // the owner restores the database only
    let error: (Error & { fix?: string }) | undefined;
    try { shared.openHookDb(env, { fts: true }); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.fix).toBe(`chmod u+w "${wal}" "${shm}"`);
    expect(mode(wal) & 0o200).toBe(0); // the hook added nothing
    expect(mode(shm) & 0o200).toBe(0);

    fs.chmodSync(wal, 0o600); // what the printed command does
    fs.chmodSync(shm, 0o600);
    const db = shared.openHookDb(env, { fts: true }).db;
    try {
      db.prepare("INSERT INTO entities (name, type) VALUES ('after-restore', 'note')").run();
      expect(db.prepare("SELECT count(*) AS n FROM entities WHERE name = 'after-restore'").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('openHookDb: a non-empty read-only -wal next to a writable database is refused and never written', () => {
    const dbPath = path.join(dataDir, 'knowledge-graph.db');
    const wal = `${dbPath}-wal`;
    const env = { ...process.env, MEMESH_DB_PATH: dbPath };
    const peer = shared.openHookDb(env, { fts: true }).db;
    try {
      peer.prepare("INSERT INTO entities (name, type) VALUES ('only-in-the-wal', 'note')").run();
      expect(fs.statSync(wal).size).toBeGreaterThan(0);
      fs.chmodSync(wal, 0o444);
      const before = fs.readFileSync(wal);
      expect(() => shared.openHookDb(env, { fts: true })).toThrow(`chmod u+w "${wal}"`);
      expect(mode(wal) & 0o200).toBe(0);
      expect(fs.readFileSync(wal).equals(before)).toBe(true);
    } finally {
      fs.chmodSync(wal, 0o600);
      peer.close();
    }
  });
});

// #520, RO3: a read-only open leaves an EMPTY 0400 -wal (and a 0400 -shm)
// behind; the owner then makes only the database writable again. SQLite
// resets an empty sidecar to the database's mode on ANY open — read-only
// handles too — so every hook entry that opens the database must refuse
// instead of letting SQLite add the owner-write bit.
describe.skipIf(!posixUser)('#520 RO3: every hook database open passes the same guard', () => {
  let home: string;
  let dataDir: string;
  let dbPath: string;
  let env: Record<string, string | undefined>;
  const sidecarsWritable = () => ['-wal', '-shm'].map((s) => (mode(`${dbPath}${s}`) & 0o200) !== 0);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ro3-'));
    dataDir = path.join(home, '.memesh');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    dbPath = path.join(dataDir, 'knowledge-graph.db');
    openDatabase(dbPath);
    closeDatabase();
    fs.chmodSync(dbPath, 0o444);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openDatabase(dbPath).prepare('SELECT count(*) FROM entities').get();
    closeDatabase();
    vi.restoreAllMocks();
    fs.chmodSync(dbPath, 0o600);
    // The state the whole suite rests on.
    expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
    expect(sidecarsWritable()).toEqual([false, false]);
    env = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: dataDir, MEMESH_DB_PATH: dbPath, MEMESH_RECIPIENT: 'ro3-principal', MEMESH_HOOK_HOST: 'claude-code' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { closeDatabase(); } catch { /* not open */ }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Each hook's outcome record for the refusal: every error row it must write.
  const refusedRow = 'uncaught MEMESH_SIDECAR_PERMISSIONS';
  const hooks: Array<[string, (cwd: string) => object, string[]]> = [
    // Only the row it always writes: its session-launcher row appears only when
    // a claude process is found among the test's ancestors, which varies by runner.
    ['session-start.js', (cwd) => ({ cwd, source: 'startup', session_id: 'ro3-s1' }), [refusedRow]],
    ['guard-check.js', (cwd) => ({ cwd, tool_name: 'Bash', tool_input: { command: 'ls' } }), [refusedRow]],
    ['pre-edit-recall.js', (cwd) => ({ cwd, tool_name: 'Edit', tool_input: { file_path: '/src/x.ts' } }), [refusedRow]],
    ['stop-message-gate.js', (cwd) => ({ cwd, session_id: 's-ro3-1', hook_event_name: 'Stop', stop_hook_active: false }), [refusedRow]],
  ];
  for (const [hook, input, errorRows] of hooks) {
    it(`${hook} leaves the owner-read-only -wal/-shm as they are and says why it did not open`, () => {
      const r = spawnSync(process.execPath, [path.resolve('scripts/hooks', hook)], {
        input: JSON.stringify(input(home)), env, encoding: 'utf8', timeout: 20000,
      });
      expect(r.status).toBe(0);
      expect(sidecarsWritable()).toEqual([false, false]);
      const ledgerPath = path.join(dataDir, 'hook-outcomes.jsonl');
      const ledger = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
      // The refusal is on the hook's own outcome record, not only on stderr.
      const reasons = ledger.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { hook?: string; outcome?: string; reason?: string })
        .filter((row) => row.hook === hook.replace(/\.js$/, '') && row.outcome === 'error')
        .map((row) => row.reason);
      for (const reason of errorRows) expect(reasons, ledger).toContain(reason);
    });
  }

  it('recordGuardFires (the fire counter) refuses too, and says so', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    shared.recordGuardFires(dbPath, [1]);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('fewer owner permissions');
    expect(sidecarsWritable()).toEqual([false, false]);
  });

  it('unreadMessageLines (the inbox read) refuses too, and reports it', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let failure = '';
    shared.unreadMessageLines(env, (err: unknown) => { failure = String((err as Error)?.message ?? err); });
    expect(failure).toContain('fewer owner permissions');
    expect(sidecarsWritable()).toEqual([false, false]);
  });

  it('the memory-invariants audit refuses too', () => {
    const r = spawnSync(process.execPath, [path.resolve('scripts/audit/memory-invariants.mjs'), '--db', dbPath], {
      env, encoding: 'utf8', timeout: 20000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('fewer owner permissions');
    expect(sidecarsWritable()).toEqual([false, false]);
  });

  for (const script of ['measure-signals.mjs', 'measure-work-topology-baseline.mjs']) {
    it(`the ${script} audit refuses too`, () => {
      const r = spawnSync(process.execPath, [path.resolve('scripts/audit', script), '--db', dbPath], {
        env, encoding: 'utf8', timeout: 20000,
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('fewer owner permissions');
      expect(sidecarsWritable()).toEqual([false, false]);
    });
  }
});

// The rule above holds only if no hook can open the database another way.
describe('#520: hooks construct MemeshDatabase only through openMemeshDb', () => {
  it('finds no other `new MemeshDatabase(` in scripts/hooks', () => {
    const dir = path.resolve('scripts/hooks');
    const sites: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
      fs.readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('new MemeshDatabase(')) sites.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(sites.length).toBeGreaterThan(0); // the scan really read the hooks
    expect(sites.filter((s) => !(
      s.startsWith('_shared.js:') && s.endsWith('return new MemeshDatabase(dbPath, options);')
    ) && !(
      // post-commit's own lock file, never the memesh database.
      s.startsWith('post-commit.js:') && s.includes('.lock.sqlite')
    ))).toEqual([]);
  });
});
