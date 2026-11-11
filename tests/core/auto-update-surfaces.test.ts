/**
 * The places that start or announce an automatic update, run as the real built
 * programs: the MCP server (registers as a running host), `memesh serve` (the
 * trigger for machines with no Claude or Codex hook), and the session-start
 * notice (must not promise more than the updater does).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-au-surf-'));
  dirs.push(d);
  return d;
}

async function waitFor(fn: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

describe.skipIf(process.platform === 'win32')('MCP server: registering as a running host', () => {
  it('logs it when it cannot register, instead of staying silent', async () => {
    const dir = tmp();
    // Hosts register in the ACCOUNT's own ~/.memesh (every data directory's update looks there), here under a throwaway HOME.
    // A file where its live-hosts directory must go: registration cannot succeed. The reason goes to the data directory's log.
    const home = tmp();
    fs.mkdirSync(path.join(home, '.memesh'));
    fs.writeFileSync(path.join(home, '.memesh', 'live-hosts'), 'not a directory');
    const child = spawn(process.execPath, [path.resolve('dist/mcp/server.js')], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'knowledge-graph.db'), MEMESH_AUTO_UPDATE: 'off' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    children.push(child);
    const logPath = path.join(dir, 'auto-update.log');
    const logged = await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('could not register this MCP host'));
    expect(logged).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('the updater may not wait for it');
  }, 30_000);

  it('registers normally (control: the failure above is the file, not the harness)', async () => {
    const dir = tmp();
    const home = tmp();
    const child = spawn(process.execPath, [path.resolve('dist/mcp/server.js')], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'knowledge-graph.db'), MEMESH_AUTO_UPDATE: 'off' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    children.push(child);
    const hostsDir = path.join(home, '.memesh', 'live-hosts');
    const registered = await waitFor(() => fs.existsSync(hostsDir) && fs.readdirSync(hostsDir).length > 0);
    expect(registered).toBe(true);
    expect(fs.existsSync(path.join(dir, 'live-hosts'))).toBe(false); // not in the data directory
    expect(fs.existsSync(path.join(dir, 'auto-update.log')) && fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8').includes('could not register')).toBe(false);
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('memesh serve starts the updater (the trigger for Hermes-only machines)', () => {
  it('asks the dispatch to start the updater, which starts nothing from a source checkout (it cannot update itself) and takes no attempt slot; and the server does not register itself as a running host', async () => {
    const dir = tmp();
    // Its own HOME: the updater it starts runs detached, and may still be writing when the suite's shared HOME is removed.
    const home = tmp();
    const child = spawn(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'serve', '--host', '127.0.0.1', '--port', '0'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'knowledge-graph.db'), MEMESH_AUTO_UPDATE: 'off' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    children.push(child);
    const logPath = path.join(dir, 'auto-update.log');
    // The gate is the dispatch's own: serve called it, and from a source checkout it answered that this install cannot update itself.
    expect(await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('cannot update itself'), 25_000)).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('no runner started');
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('DISPATCHED');
    // Nothing shared was taken: no attempt time (the 6-hour slot every install of this account shares), no record of a "skipped" attempt.
    expect(fs.existsSync(path.join(dir, 'auto-update-attempt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'auto-update-state.json'))).toBe(false);
    for (const where of [dir, path.join(home, '.memesh')]) {
      const hosts = path.join(where, 'live-hosts');
      expect(fs.existsSync(hosts) ? fs.readdirSync(hosts).filter((f) => f.startsWith(`${child.pid}.`)) : []).toHaveLength(0);
    }
  }, 40_000);
});

describe.skipIf(process.platform === 'win32')('memesh serve keeps what it writes owner-only, also in a directory that was made looser', () => {
  it('tightens the data directory and the log of an existing 0755 / 0644 setup (the attempt time is tightened where it is written: see the dispatch test in auto-update.test.ts)', async () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o755);
    for (const name of ['auto-update.log', 'auto-update-attempt']) {
      fs.writeFileSync(path.join(dir, name), name === 'auto-update-attempt' ? '0' : '', { mode: 0o644 });
      fs.chmodSync(path.join(dir, name), 0o644);
    }
    const child = spawn(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'serve', '--host', '127.0.0.1', '--port', '0'], {
      env: { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'knowledge-graph.db'), MEMESH_AUTO_UPDATE: 'off' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    children.push(child);
    const logPath = path.join(dir, 'auto-update.log');
    expect(await waitFor(() => fs.readFileSync(logPath, 'utf8').includes('cannot update itself'), 25_000)).toBe(true);
    const mode = (f: string) => fs.statSync(f).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    expect(mode(logPath)).toBe(0o600);
  }, 40_000);
});

describe('the session-start notice does not promise more than the updater does', () => {
  const source = fs.readFileSync(path.resolve('scripts/hooks/session-start.js'), 'utf8');
  const line = source.split('\n').find((l) => l.includes('is available (you\'re on'));

  it('says MeMesh will try, names what it skips, and points to doctor and the off switch', () => {
    expect(line).toBeDefined();
    expect(line).toContain('will try to install it');
    expect(line).toContain('anything it cannot verify');
    expect(line).toContain('memesh doctor');
    expect(line).toContain('memesh config set autoUpdate off');
  });

  it('does not say it installs by itself', () => {
    expect(line).not.toMatch(/installs by itself|will be installed|is installed automatically/i);
  });
});

describe('the release workflow', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/publish-npm.yml'), 'utf8');

  it('checks that the tagged commit is on main, inside the existing job, before anything is set up or published', () => {
    // the direction of the test matters: a commit that is NOT an ancestor of main is refused
    expect(workflow).toContain('if ! git merge-base --is-ancestor HEAD origin/main; then');
    const check = workflow.indexOf('git merge-base --is-ancestor HEAD origin/main');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(workflow.indexOf('Setup Node.js'));
    expect(workflow.slice(check, check + 400)).toContain('exit 1');
    // The tag name is never interpolated into the script.
    const stepStart = workflow.lastIndexOf('- name:', check);
    const stepEnd = workflow.indexOf('- name:', check);
    expect(workflow.slice(stepStart, stepEnd)).not.toContain('${{');
  });
});

describe('the release workflow only runs on a release tag (a certificate signed at a branch is refused by every updater)', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/publish-npm.yml'), 'utf8');
  const steps = workflow.slice(workflow.indexOf('    steps:'));

  it('its FIRST step stops a run whose ref is not refs/tags/v*, naming the right way to start it', () => {
    const first = steps.indexOf('- name:');
    expect(steps.slice(first, steps.indexOf('\n      - name:', first + 1))).toContain('Run on a release tag');
    const guard = steps.slice(first, steps.indexOf('\n      - name:', first + 1));
    expect(guard).toContain('refs/tags/v*) ;;');
    expect(guard).toContain('exit 1');
    expect(guard).toContain('gh workflow run publish-npm.yml --ref vX.Y.Z -f release_tag=vX.Y.Z');
    // the ref is read from the environment, never interpolated into the script
    expect(guard).not.toContain('${{');
  });

  it('is in the existing job: no job and no workflow was added for it', () => {
    expect((workflow.match(/^ {2}[a-z-]+:\n {4}(?:if|runs-on|needs)/gm) ?? []).length).toBeLessThanOrEqual(3);
    expect(fs.readdirSync(path.resolve('.github/workflows')).filter((f) => /publish/.test(f))).toEqual(['publish-npm.yml']);
  });

  it('a retry must be on the tag it publishes: GITHUB_REF equals refs/tags/<release_tag>', () => {
    const validate = steps.slice(steps.indexOf('- name: Validate prerelease retry'), steps.indexOf('- name: Checkout code'));
    expect(validate).toContain('test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"');
  });

  it('what a person is told to do is the same everywhere: --ref on the tag', () => {
    const contributing = fs.readFileSync(path.resolve('CONTRIBUTING.md'), 'utf8');
    expect(contributing).toContain('gh workflow run publish-npm.yml --ref vX.Y.Z -f release_tag=vX.Y.Z');
    expect(contributing).not.toMatch(/gh workflow run publish-npm\.yml -f release_tag/);
  });
});

describe('memesh update (the real CLI)', () => {
  it('on a source checkout it refuses with the install channel and exits 1, without installing anything', () => {
    const dir = tmp();
    const r = spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'update'], {
      env: { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'knowledge-graph.db') },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/does not support this install/);
    expect(fs.existsSync(path.join(dir, 'auto-update-state.json'))).toBe(false);
  }, 90_000);

  it('--reinstall is a real option, and is refused the same way on an install that cannot update itself', () => {
    const dir = tmp();
    const env = { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'knowledge-graph.db') };
    const help = spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'update', '--help'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(help.stdout).toContain('--reinstall');
    const r = spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'update', '--reinstall'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/does not support this install/);
    expect(fs.existsSync(path.join(dir, 'auto-update-state.json'))).toBe(false);
  }, 90_000);
});
