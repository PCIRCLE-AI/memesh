/**
 * The empty-briefing sentence tells a new user how to store the first memory.
 * Two promises, both proved against the built CLI with a throwaway HOME:
 *
 *  1. The command it prints, copied as printed, stores the memory in THIS
 *     project: the next briefing here shows it and another project's briefing
 *     does not. (It used to omit the project, so the memory belonged to no
 *     project and appeared in every project's briefing.)
 *  2. `memesh briefing` only reads: on a HOME with no database it answers the
 *     same as on an empty database and leaves no database file behind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CLI_PATH, cliEnv, runCli } from '../helpers/built-cli.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { canDenyReads } from '../helpers/permissions.js';

// A mode bit is no barrier to root or on Windows: those cases are skipped there, not passed untested.
// A root-owned folder this user cannot write to, if the system has one (macOS and most Linux have /var/empty).
const otherUsersFolder = process.platform !== 'win32' && fs.existsSync('/var/empty') && fs.statSync('/var/empty').uid !== process.getuid?.();

function gitRepo(name: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-briefing-first-')));
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  const r = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return repo;
}

describe('empty briefing: the first-memory sentence and a read-only briefing', () => {
  let home: string;
  const repos: string[] = [];
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-briefing-first-home-'));
  });
  afterEach(() => {
    removeTempDir(home);
    for (const repo of repos.splice(0)) fs.rmSync(path.dirname(repo), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function env(h: string, level = 'minimal'): NodeJS.ProcessEnv {
    return cliEnv(h, { MEMESH_BRIEFING: level, MEMESH_AUTO_CAPTURE: 'false' });
  }
  function cli(cwd: string, args: string[], h = home, level = 'minimal') {
    return runCli(args, { cwd, env: env(h, level) });
  }
  /** Run a printed `memesh …` command line as a shell would, with `memesh` standing for the built CLI. */
  function shell(cwd: string, command: string, h = home) {
    expect(command.startsWith('memesh ')).toBe(true);
    const r = spawnSync('sh', ['-c', `node "$MEMESH_TEST_CLI" ${command.slice('memesh '.length)}`], {
      encoding: 'utf8', env: { ...env(h), MEMESH_TEST_CLI: CLI_PATH }, cwd, timeout: 30000,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  const dbExists = (h: string) => fs.existsSync(path.join(h, '.memesh', 'knowledge-graph.db'));

  it('the printed command, copied as printed, stores the memory in this project and no other', () => {
    const projectA = gitRepo('first-memory-alpha');
    const projectB = gitRepo('first-memory-bravo');
    repos.push(projectA, projectB);

    const empty = cli(projectA, ['briefing']);
    expect(empty.status, empty.stderr).toBe(0);
    const line = empty.stdout.trim();
    expect(line.length, 'the briefing printed nothing').toBeGreaterThan(0);
    expect(line).toMatch(/^Nothing to brief at level minimal/);
    const command = line.slice(line.indexOf('memesh remember'));
    expect(command).toMatch(/^memesh remember /);

    const stored = shell(projectA, command);
    expect(stored.status, stored.stderr).toBe(0);
    expect(stored.stdout).toContain('Stored');

    const here = cli(projectA, ['briefing']);
    expect(here.status, here.stderr).toBe(0);
    expect(here.stdout, 'the briefing is still the empty line: the memory was stored somewhere this project does not read').not.toMatch(/^Nothing to brief/);
    expect(here.stdout, 'the memory stored with the printed command is missing from this project\'s briefing').toContain('what to remember');
    expect(here.stdout).toContain('first-memory-alpha');
    expect(here.stdout).not.toContain('Your memories with no project');

    const other = cli(projectB, ['briefing']);
    expect(other.status, other.stderr).toBe(0);
    // Still the empty line (whose own example command mentions the example text),
    // not a briefing block carrying the other project's memory.
    expect(other.stdout, 'a memory stored for one project leaked into another project\'s briefing').toMatch(/^Nothing to brief at level minimal/);
    expect(other.stdout).not.toContain('[note]');
    expect(other.stdout).not.toContain('MeMesh reference memory');
  });

  it.each([
    ['minimal', [] as string[]],
    ['minimal', ['--json']],
    ['standard', []],
    ['standard', ['--json']],
    ['standard', ['--index']],
    ['standard', ['--index', '--json']],
  ])('on a HOME with no database, briefing (%s %j) answers as on an empty database and creates none', (level, flags) => {
    const project = gitRepo('first-memory-readonly');
    const elsewhere = gitRepo('first-memory-elsewhere');
    repos.push(project, elsewhere);

    // The reference: a home whose database exists and holds nothing for `project`.
    const refHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-briefing-first-ref-'));
    try {
      const seeded = cli(elsewhere, ['remember', '--name', 'other-project-memory', '--type', 'note', '--obs', 'unrelated', '--tags', 'project:first-memory-elsewhere'], refHome, level);
      expect(seeded.status, seeded.stderr).toBe(0);
      expect(dbExists(refHome), 'the reference home has no database').toBe(true);
      const reference = cli(project, ['briefing', ...flags], refHome, level);
      expect(reference.status, reference.stderr).toBe(0);

      expect(dbExists(home)).toBe(false);
      const actual = cli(project, ['briefing', ...flags], home, level);
      expect(actual.status, actual.stderr).toBe(0);
      expect(actual.stdout).toBe(reference.stdout);
      expect(dbExists(home), 'a read-only briefing created the database').toBe(false);
    } finally {
      removeTempDir(refHome);
    }
  });

  it('needs no scratch folder: with TMPDIR pointing nowhere, a briefing on a HOME with no database still answers and creates none', () => {
    const project = gitRepo('first-memory-no-tmpdir');
    repos.push(project);
    const nowhere = path.join(home, 'no-such-tmp-folder');
    const r = runCli(['briefing'], { cwd: project, env: { ...env(home), TMPDIR: nowhere, TMP: nowhere, TEMP: nowhere } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^Nothing to brief at level minimal/);
    expect(dbExists(home), 'a briefing with no scratch folder created the database').toBe(false);
  });

  describe.skipIf(!canDenyReads)('when MeMesh cannot write, the empty briefing does not teach a step that cannot work (D15)', () => {
    /** Not the `remember` command; says what cannot be written; and its fix is the exact chmod for exactly those paths. */
    const explains = (out: string, unwritable: string[]) => {
      expect(out, 'the briefing still tells the user to run `memesh remember`').not.toContain('memesh remember');
      expect(out).toMatch(/cannot write/i);
      expect(out).toContain('memesh doctor');
      for (const target of unwritable) expect(out, `${target} is not named`).toContain(target);
      expect(out).toContain(`chmod u+w ${unwritable.map((t) => `'${t}'`).join(' ')}`);
    };
    /** The chmod command the briefing printed, as a shell would run it. */
    const printedChmod = (out: string): string => {
      const found = out.match(/chmod u\+w(?: '[^']*')+/);
      expect(found, `no chmod command in: ${out}`).not.toBeNull();
      return found![0];
    };

    it('a memesh folder that cannot be written (no database yet)', () => {
      const project = gitRepo('first-memory-unwritable-dir');
      repos.push(project);
      const dir = path.join(home, '.memesh');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o555);
      try {
        expect(() => fs.writeFileSync(path.join(dir, 'probe'), 'x'), 'the folder is writable: this test would prove nothing').toThrow();
        const r = cli(project, ['briefing']);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/^Nothing to brief at level minimal/);
        explains(r.stdout, [dir]);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    });

    it.each([['minimal'], ['standard']])('a database that can be read but not written (level %s): the printed chmod really makes it writable, and then remember works', (level) => {
      const project = gitRepo(`first-memory-readonly-db-${level}`);
      const elsewhere = gitRepo(`first-memory-readonly-db-else-${level}`);
      repos.push(project, elsewhere);
      const seeded = cli(elsewhere, ['remember', '--name', 'other', '--type', 'note', '--obs', 'unrelated', '--tags', `project:first-memory-readonly-db-else-${level}`]);
      expect(seeded.status, seeded.stderr).toBe(0);
      const db = path.join(home, '.memesh', 'knowledge-graph.db');
      fs.chmodSync(db, 0o444);
      expect(() => fs.appendFileSync(db, '')).toThrow();

      const r = cli(project, ['briefing'], home, level);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.length, 'the briefing printed nothing').toBeGreaterThan(0);
      // The read-only open left its own -wal/-shm beside the database, owner-only and read-only: making only the
      // database writable again is refused by the next open. So the fix has to name every file that is in the way.
      expect(r.stdout).toContain(db);
      expect(r.stdout, 'the briefing still tells the user to run `memesh remember`').not.toContain('memesh remember');
      expect(r.stdout).toMatch(/cannot write/i);
      const command = printedChmod(r.stdout);
      expect(command).toContain(`'${db}'`);

      // Run exactly what was printed, then store a memory: that is the point of the sentence.
      const ran = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
      expect(ran.status, `${command}\n${ran.stderr}`).toBe(0);
      const stored = cli(project, ['remember', '--name', 'after-the-fix', '--type', 'note', '--obs', 'saved after following the briefing', '--tags', `project:first-memory-readonly-db-${level}`], home, level);
      expect(stored.status, `${stored.stdout}${stored.stderr}`).toBe(0);
      expect(stored.stdout).toContain('Stored');
    });

    it.skipIf(!otherUsersFolder)('a folder that belongs to another user: it points at MEMESH_DB_PATH and prints no chmod', () => {
      const root = '/var/empty';
      const project = gitRepo('first-memory-other-users-folder');
      repos.push(project);
      const r = runCli(['briefing'], { cwd: project, env: { ...env(home), MEMESH_DB_PATH: path.join(root, 'sub', 'knowledge-graph.db') } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(root);
      expect(r.stdout).toContain('belongs to another user');
      expect(r.stdout).toContain('MEMESH_DB_PATH');
      expect(r.stdout, 'a chmod the user cannot run was printed').not.toContain('chmod u+w');
    });
  });
});
