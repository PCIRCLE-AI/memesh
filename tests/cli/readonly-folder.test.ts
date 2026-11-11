/**
 * A memesh folder the user cannot write, holding a database that was closed
 * cleanly (WAL mode, no -wal, no -shm). The session-start hook reads it, and
 * its message says recall still works; the CLI used to refuse to open it at
 * all, so `briefing` and `recall` returned nothing at the very moment the user
 * went looking. Reads now work (the file is opened immutable, read-only);
 * writes are refused, and the refusal says why and what to run.
 *
 * Runs the built CLI against a throwaway HOME. Skipped for root and on
 * Windows, where a mode bit is no barrier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cliEnv, runCli } from '../helpers/built-cli.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { leaveHotJournal } from '../helpers/hot-journal.js';
import { canDenyReads } from '../helpers/permissions.js';


describe.skipIf(!canDenyReads)('a memesh folder that cannot be written, with a cleanly closed WAL database', () => {
  let home: string;
  let repo: string;
  let dir: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-readonly-folder-'));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-readonly-folder-repo-')));
    dir = path.join(home, '.memesh');
  });
  afterEach(() => {
    try { fs.chmodSync(dir, 0o755); } catch { /* gone */ }
    removeTempDir(home, repo);
  });

  const cli = (args: string[]) => runCli(args, { cwd: repo, env: cliEnv(home, { MEMESH_AUTO_CAPTURE: 'false', MEMESH_BRIEFING: 'minimal' }) });

  /** One memory in this project, then the folder locked, with no -wal and no -shm left. */
  function seedAndLock(): void {
    const stored = cli(['remember', '--name', 'readonly-folder-memory', '--type', 'note', '--obs', 'the quick brown readonly marker', '--tags', `project:${path.basename(repo)}`]);
    expect(stored.status, stored.stderr).toBe(0);
    const files = fs.readdirSync(dir);
    expect(files.length, 'the memesh folder is empty').toBeGreaterThan(0);
    expect(files.filter((f) => f.endsWith('-wal') || f.endsWith('-shm')), 'the seed left sidecars: not the cleanly-closed state').toEqual([]);
    const db = path.join(dir, 'knowledge-graph.db');
    const header = Buffer.alloc(20);
    const fd = fs.openSync(db, 'r');
    try { fs.readSync(fd, header, 0, 20, 0); } finally { fs.closeSync(fd); }
    expect([header[18], header[19]], 'the database is not in WAL mode').toEqual([2, 2]);
    fs.chmodSync(dir, 0o555);
    expect(() => fs.writeFileSync(path.join(dir, 'probe'), 'x'), 'the folder is writable: this test would prove nothing').toThrow();
  }

  /** What a refusal has to say: which folder, and the exact command that fixes it. */
  const names = (text: string) => {
    expect(text, 'the message does not name the folder').toContain(dir);
    expect(text, 'the message does not give the command that fixes it').toContain(`chmod u+w '${dir}'`);
  };

  it('briefing reads the memory, and says on stderr which folder is read-only and how to undo it', () => {
    seedAndLock();
    const r = cli(['briefing']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('the quick brown readonly marker');
    names(r.stderr);
  });

  it('recall reads the memory', () => {
    seedAndLock();
    const r = cli(['recall', 'readonly marker']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('readonly-folder-memory');
  });

  it('remember is refused, and the Error line names the folder and the command', () => {
    seedAndLock();
    const r = cli(['remember', '--name', 'another', '--type', 'note', '--obs', 'cannot be saved']);
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0);
    // The refusal itself (the `Error:` line), not only the line printed when the database was opened.
    const errorLine = r.stderr.split('\n').find((line) => line.startsWith('Error: ')) ?? '';
    names(errorLine);
    fs.chmodSync(dir, 0o755);
    const after = cli(['recall', 'cannot be saved']);
    expect(after.stdout, 'a refused write was stored anyway').not.toContain('another');
  });

  it.each([
    ['forget', ['forget', '--name', 'readonly-folder-memory']],
    ['task', ['task', '--goal', 'cannot be saved']],
  ])('%s is refused the same way: the Error line names the folder and the command', (_name, args) => {
    seedAndLock();
    const r = cli(args as string[]);
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0);
    const errorLine = r.stderr.split('\n').find((line) => line.startsWith('Error: ')) ?? '';
    names(errorLine);
  });

  it('a -wal that holds pages still stops, naming the folder: it cannot be skipped', () => {
    seedAndLock();
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'knowledge-graph.db-wal'), Buffer.alloc(64, 1));
    fs.chmodSync(dir, 0o555);
    const r = cli(['briefing']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(dir);
    expect(`${r.stdout}${r.stderr}`).toContain(`chmod u+w '${dir}'`);
  });

  it('a transaction a crash left half done (a hot journal) is never read as committed: the CLI stops, naming the folder', () => {
    seedAndLock();
    fs.chmodSync(dir, 0o755);
    leaveHotJournal(path.join(dir, 'knowledge-graph.db'));
    fs.chmodSync(dir, 0o555);
    for (const args of [['briefing'], ['recall', 'readonly marker']]) {
      const r = cli(args);
      expect(r.status, `${args.join(' ')}: ${r.stdout}${r.stderr}`).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('unfinished transaction');
      expect(`${r.stdout}${r.stderr}`).toContain(`chmod u+w '${dir}'`);
      expect(r.stdout, 'something was read from a half-done transaction').not.toContain('CHANGED');
    }
  });
});
