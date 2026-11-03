/**
 * The automatic updater tells upgrade-plugin.sh which commit a release's
 * provenance names. The script must refuse anything that is not that release,
 * before it stages or installs a thing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from './helpers/temp-dir.js';

const dirs: string[] = [];
afterEach(() => { removeTempDir(...dirs.splice(0)); });

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const OFFICIAL = 'https://github.com/PCIRCLE-AI/memesh.git';
/** The clone's origin is the official address (what the script requires); git is told to fetch it from `local` instead. */
function officialOrigin(clone: string, local: string): void {
  git(clone, 'remote', 'set-url', 'origin', OFFICIAL);
  git(clone, 'config', `url.${local}.insteadOf`, OFFICIAL);
}

/** A Claude config root whose marketplace cache is a clone of a one-commit origin. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pin-'));
  dirs.push(root);
  const origin = path.join(root, 'origin');
  fs.mkdirSync(path.join(origin, '.claude-plugin'), { recursive: true });
  git(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'memesh', version: '1.0.0' }] }));
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'one');
  const sha = git(origin, 'rev-parse', 'HEAD');
  const config = path.join(root, 'claude');
  fs.mkdirSync(path.join(config, 'plugins', 'marketplaces'), { recursive: true });
  git(root, 'clone', '-q', origin, path.join(config, 'plugins', 'marketplaces', 'pcircle-memesh'));
  officialOrigin(path.join(config, 'plugins', 'marketplaces', 'pcircle-memesh'), origin);
  fs.mkdirSync(path.join(config, 'plugins', 'cache', 'pcircle-memesh'), { recursive: true });
  fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
  return { config, sha };
}

function run(config: string, extra: Record<string, string>) {
  return spawnSync('bash', [path.resolve('scripts/upgrade-plugin.sh')], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, ...extra },
    timeout: 60_000,
  });
}

describe.skipIf(process.platform === 'win32')('upgrade-plugin.sh with a pinned release commit', () => {
  it('refuses a pin that is not a full commit id', () => {
    const f = fixture();
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: 'abc123' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not a full 40-hex commit');
    expect(r.stdout).not.toContain('Target version');
  });

  it('refuses a pin that is not part of the marketplace history', () => {
    const f = fixture();
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: 'a'.repeat(40) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not part of the marketplace history');
    expect(r.stdout).not.toContain('Target version');
  });

  it.each([
    ['not a full commit id', 'abc123'],
    ['not part of the history', 'a'.repeat(40)],
  ])('a refused pin (%s) leaves the marketplace checkout where it was, even when origin has moved on', (_label, pin) => {
    const f = fixture();
    const clone = path.join(f.config, 'plugins', 'marketplaces', 'pcircle-memesh');
    const origin = path.join(path.dirname(f.config), 'origin');
    fs.writeFileSync(path.join(origin, 'later.txt'), 'a newer commit');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'two');
    const before = git(clone, 'rev-parse', 'HEAD');
    expect(git(origin, 'rev-parse', 'HEAD')).not.toBe(before);
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: pin });
    expect(r.status).toBe(1);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(fs.existsSync(path.join(clone, 'later.txt'))).toBe(false);
  });

  /** A clone with two further commits on origin; returns the shas. */
  function withTwoNewerCommits() {
    const f = fixture();
    const clone = path.join(f.config, 'plugins', 'marketplaces', 'pcircle-memesh');
    const origin = path.join(path.dirname(f.config), 'origin');
    const shas: string[] = [];
    for (const name of ['two', 'three']) {
      fs.writeFileSync(path.join(origin, `${name}.txt`), name);
      git(origin, 'add', '.');
      git(origin, 'commit', '-q', '-m', name);
      shas.push(git(origin, 'rev-parse', 'HEAD'));
    }
    return { f, clone, origin, shas };
  }

  it('an accepted pin moves the checkout to THAT commit, not to whatever origin holds now', () => {
    const { f, clone, shas } = withTwoNewerCommits();
    // (the later steps fail in this fixture, which has no package.json: what is checked is where the checkout was moved to)
    run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: shas[0], MEMESH_UPGRADE_EXPECT_VERSION: '1.0.0' });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(shas[0]);
    expect(git(clone, 'rev-parse', 'HEAD')).not.toBe(shas[1]);
  });

  it('a pin that exists only as a local commit in the checkout (not on origin) is refused, and the checkout does not move', () => {
    const { f, clone } = withTwoNewerCommits();
    fs.writeFileSync(path.join(clone, 'local-only.txt'), 'never pushed');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'local only');
    const localSha = git(clone, 'rev-parse', 'HEAD');
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: localSha });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not part of the marketplace history');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(localSha);
    expect(fs.existsSync(path.join(clone, 'two.txt'))).toBe(false);
  });

  it('refuses when the pinned commit holds a different version than the release', () => {
    const f = fixture();
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: f.sha, MEMESH_UPGRADE_EXPECT_VERSION: '9.9.9' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('holds version 1.0.0, but the release being installed is 9.9.9');
    expect(r.stdout).not.toContain('Target version');
  });

  it('a pin that holds another version than the release leaves the marketplace checkout where it was, even when origin has moved on (the checks come before the move)', () => {
    const { f, clone, shas } = withTwoNewerCommits();
    const before = git(clone, 'rev-parse', 'HEAD');
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: shas[0], MEMESH_UPGRADE_EXPECT_VERSION: '9.9.9' });
    expect(r.status).toBe(1);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(fs.existsSync(path.join(clone, 'two.txt'))).toBe(false);
  });

  it('the form of the pin is checked before anything asks the network: an unreachable origin does not hide it', () => {
    const f = fixture();
    const clone = path.join(f.config, 'plugins', 'marketplaces', 'pcircle-memesh');
    git(clone, 'config', `url.${path.join(path.dirname(f.config), 'no-such-origin')}.insteadOf`, OFFICIAL);
    git(clone, 'config', '--unset-all', `url.${path.join(path.dirname(f.config), 'origin')}.insteadOf`);
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: 'abc123' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not a full 40-hex commit');
    expect(r.stderr).not.toContain('git fetch failed');
  });

  it('a fetch that fails says why (git\'s own words), not just that it failed', () => {
    const f = fixture();
    const clone = path.join(f.config, 'plugins', 'marketplaces', 'pcircle-memesh');
    git(clone, 'config', `url.${path.join(path.dirname(f.config), 'no-such-origin')}.insteadOf`, OFFICIAL);
    git(clone, 'config', '--unset-all', `url.${path.join(path.dirname(f.config), 'origin')}.insteadOf`);
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: f.sha });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('git fetch failed in');
    expect(r.stderr).toMatch(/no-such-origin|does not appear to be a git repository|Could not read from remote/);
  });

  it('an environment that points git at another repository does not redirect the script (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR)', () => {
    const f = fixture();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-other-repo-'));
    dirs.push(elsewhere);
    git(elsewhere, 'init', '-q', '-b', 'main');
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: f.sha, MEMESH_UPGRADE_EXPECT_VERSION: '9.9.9', GIT_DIR: path.join(elsewhere, '.git'), GIT_WORK_TREE: elsewhere, GIT_INDEX_FILE: path.join(elsewhere, '.git', 'index'), GIT_COMMON_DIR: path.join(elsewhere, '.git') });
    // it reached the version check of the REAL marketplace checkout (1.0.0), instead of failing in the other repository
    expect(r.stderr).toContain('holds version 1.0.0, but the release being installed is 9.9.9');
  });

  it('a checkout that cannot be fast-forwarded (a file of its own where the release has one) does not stop the install: it stays where it is, with a warning', () => {
    const { f, clone, shas } = withTwoNewerCommits();
    fs.writeFileSync(path.join(clone, 'two.txt'), 'mine, and in the way of the release');
    const before = git(clone, 'rev-parse', 'HEAD');
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: shas[1], MEMESH_UPGRADE_EXPECT_VERSION: '1.0.0' });
    expect(r.stderr).toContain('the marketplace checkout was not moved to the release');
    expect(r.stderr).not.toContain('marketplace fast-forward failed');
    expect(r.stdout).toContain('Target version: 1.0.0'); // it went on (and fails later in this fixture, which has no registry entry)
    expect(fs.readFileSync(path.join(clone, 'two.txt'), 'utf8')).toBe('mine, and in the way of the release');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('without a pin (the repair) nothing is fetched and nothing moves: origin\'s newer commit is neither downloaded nor checked out', () => {
    const { f, clone, shas } = withTwoNewerCommits();
    const before = git(clone, 'rev-parse', 'HEAD');
    const remoteBefore = git(clone, 'rev-parse', 'refs/remotes/origin/main');
    expect(remoteBefore).toBe(before); // the clone knows only the first commit
    run(f.config, {}); // the later steps fail in this fixture (no registry entry); what is checked is the checkout
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remoteBefore); // not fetched
    expect(spawnSync('git', ['cat-file', '-e', `${shas[1]}^{commit}`], { cwd: clone }).status === 0).toBe(false); // the newer commit is not even in the clone
  });

  it.each([
    ['another repository', 'https://github.com/someone-else/memesh.git'],
    ['a local path', '/tmp/somewhere/else'],
    ['an address that only starts like the official one', 'https://github.com/PCIRCLE-AI/memesh.git.evil.test/x'],
  ])('an origin that is %s is refused with the reason, before anything is fetched, and nothing moves', (_label, url) => {
    const { f, clone } = withTwoNewerCommits();
    git(clone, 'remote', 'set-url', 'origin', url);
    const before = git(clone, 'rev-parse', 'HEAD');
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: f.sha });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not the official repository');
    expect(r.stderr).toContain(url);
    expect(r.stdout).not.toContain('Fetching');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('an origin that is not set is refused too', () => {
    const { f, clone } = withTwoNewerCommits();
    git(clone, 'remote', 'remove', 'origin');
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: f.sha });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not set');
  });

  it('the official address is accepted in the forms GitHub gives it (https with and without .git, ssh)', () => {
    for (const url of ['https://github.com/PCIRCLE-AI/memesh', 'git@github.com:PCIRCLE-AI/memesh.git', 'git@github.com:PCIRCLE-AI/memesh-llm-memory.git', 'https://github.com/PCIRCLE-AI/memesh-llm-memory']) {
      const { f, clone, origin } = withTwoNewerCommits();
      git(clone, 'remote', 'set-url', 'origin', url);
      git(clone, 'config', `url.${origin}.insteadOf`, url);
      const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: f.sha, MEMESH_UPGRADE_EXPECT_VERSION: '9.9.9' });
      expect(r.stderr, url).toContain('holds version 1.0.0, but the release being installed is 9.9.9'); // it got past the origin check
    }
  });

  it('a pin that names an annotated tag\'s object is resolved to its commit', () => {
    const { f, clone, origin, shas } = withTwoNewerCommits();
    git(origin, 'tag', '-a', 'v-annotated', '-m', 'annotated', shas[0]);
    const tagObject = git(origin, 'rev-parse', 'v-annotated');
    expect(tagObject).not.toBe(shas[0]);
    git(clone, 'fetch', '-q', 'origin', '--tags');
    const r = run(f.config, { MEMESH_UPGRADE_PIN_COMMIT: tagObject, MEMESH_UPGRADE_EXPECT_VERSION: '1.0.0' });
    // what is archived and recorded is the COMMIT the tag points at, and the script says which one it is
    expect(r.stdout).toContain(`Release commit: ${shas[0]}`);
    expect(r.stdout).not.toContain(tagObject);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(shas[0]);
  });
});
