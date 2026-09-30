/**
 * `memesh doctor --fix` through the real binary. The whitelist executes only
 * fixId-tagged prescriptions; the verdict comes from a fresh doctor run, not
 * from trusting the fixes. Fixture HOME throughout — never the real one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, openDatabase } from '../../src/db.js';

const CLI = path.resolve('dist/transports/cli/cli.js');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-docfix-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const env = () => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  // No MEMESH_DIR override: memeshDir derives from HOME, and the hook-wiring
  // registry consult derives from HOME too — one fixture, both aligned.
});

const run = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env() });

describe('memesh doctor --fix', () => {
  it('refuses to change anything non-interactively without --yes', () => {
    const r = run(['doctor', '--fix']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--yes');
    // Nothing was wired.
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('wires the hooks on a fresh HOME and shows the check flipping warn → pass', () => {
    const r = run(['doctor', '--fix', '--yes']);

    // The fix really landed: settings.json carries the _memesh markers and
    // the install-hooks marker file exists (which is what the re-run's
    // hook-wiring check reads).
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks?: Record<string, Array<{ hooks: Array<{ _memesh?: boolean }> }>> };
    const markers = Object.values(settings.hooks ?? {})
      .flat().flatMap((e) => e.hooks).filter((h) => h._memesh === true);
    expect(markers.length).toBeGreaterThan(0);

    expect(r.stdout).toContain('After fixes:');
    expect(r.stdout).toMatch(/Hooks wired into Claude Code: warn → pass/);
  });

  it('has nothing to apply when the plugin manages the machine', () => {
    const pluginsDir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      plugins: { 'memesh@pcircle-memesh': [{ installPath: '/x', version: '9.9.9', scope: 'user' }] },
    }));

    const r = run(['doctor', '--fix', '--yes']);
    expect(r.stdout).toContain('Nothing on the --fix whitelist to apply.');
    // And it did NOT write hooks over the plugin's management.
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  describe('#520: removes other users\' access, never gives the owner back a permission', () => {
    const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0;
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    let dataDir: string;
    let dbPath: string;

    beforeEach(() => {
      dataDir = path.join(home, '.memesh');
      dbPath = path.join(dataDir, 'knowledge-graph.db');
      openDatabase(dbPath);
      closeDatabase();
    });

    afterEach(() => {
      try { fs.chmodSync(dataDir, 0o700); fs.chmodSync(dbPath, 0o600); } catch { /* gone */ }
    });

    it.skipIf(!posixUser)('a read-only database in a read-only folder keeps its owner bits, and doctor says how to restore them', () => {
      fs.chmodSync(dbPath, 0o444);
      fs.chmodSync(dataDir, 0o555);
      const r = run(['doctor', '--fix', '--yes']);
      expect(mode(dbPath)).toBe(0o400); // owner r-- kept; group/other read removed
      expect(mode(dataDir)).toBe(0o500); // owner r-x kept; group/other removed
      expect(r.stdout).not.toContain('permissions restored');
      // The open's own reason (the folder is read-only and the database has
      // no -wal/-shm to read from) and its one command, never a move/reset.
      const database = r.stdout.match(/\[FAIL\] Database\n([^\n]*)\n\s*Fix: ([^\n]*)/);
      expect(database?.[1]).toContain(`${dataDir} is read-only`);
      expect(database?.[2]).toBe(`Run: chmod u+w '${dataDir}'`);
      expect(r.stdout).not.toMatch(/Backup and reset|\bmv '/);
    });

    it.skipIf(!posixUser)('a read-only database is named read-only in the Database row, with the command', () => {
      fs.chmodSync(dbPath, 0o444);
      const r = run(['doctor']);
      const database = r.stdout.match(/\[(\w+)\] Database\n([^\n]*)\n\s*Fix: ([^\n]*)/);
      expect(database?.[1]).toBe('WARN');
      expect(database?.[2]).toContain('is read-only');
      expect(database?.[3]).toContain(`chmod u+w '${dbPath}'`);
      expect(mode(dbPath)).toBe(0o400);
    });

    it.skipIf(!posixUser)('a world-readable database and folder become owner-only', () => {
      fs.chmodSync(dbPath, 0o644);
      fs.chmodSync(dataDir, 0o755);
      run(['doctor', '--fix', '--yes']);
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(dataDir)).toBe(0o700);
    });
  });
});
