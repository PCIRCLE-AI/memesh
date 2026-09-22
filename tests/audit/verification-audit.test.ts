/**
 * `scripts/audit/verification-audit.mjs` walks the filesystem
 * (`fs.readdirSync`) to build each detector's candidate list. On a machine
 * that keeps the departed SDLC-loop files on disk as maintainer-local,
 * git-ignored tooling — restored from a backup after the removal in this
 * repository, exactly as the owner's checkout does — every detector still
 * saw those files, found no baseline entry for them (correctly: they are
 * not in the repository), and the audit went permanently red on that one
 * machine while staying green on every fresh clone and in CI. The gate's
 * verdict must depend on the tree and the machine's own git ignore rules
 * (`.gitignore`, `.git/info/exclude`, `core.excludesFile`), not on whatever
 * untracked local files with no ignore rule at all happen to be sitting in
 * the working copy — the same guarantee `treeHash()`
 * (scripts/lib/verify-core.mjs) gives receipts. A path that is actually in
 * the repository (the index) is never dropped by this filter regardless of
 * any exclude rule, so a machine-local exclude can only make one
 * developer's own run scan less than CI, never CI less
 * (scripts/lib/git-ignored-paths.mjs has the full reasoning).
 *
 * These cases pin both directions, same reason as tests/gitignore-scope.test.ts
 * pins both directions for the benchmarks/ allow-list: a fix that makes the
 * audit blind to real findings in tracked (or merely untracked-but-not-yet-
 * ignored) files is not a fix, it is a new way to hide one.
 *
 * The `filterIgnored` unit describe below runs against disposable temp repos
 * it creates and deletes itself. The describe block that exercises the
 * actual verification-audit.mjs script does the same, at repository scale:
 * it builds a throwaway copy of this repository's own working tree (see
 * `buildRepoCopy`) and runs entirely inside it — never against this
 * checkout — so nothing here can be affected by what HEAD does or does not
 * contain, or touch a maintainer's real local files at the same paths.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROUTING_GIT_VARS, _resetWarningsForTest, filterIgnored } from '../../scripts/lib/git-ignored-paths.mjs';
import { stripComments } from '../../scripts/lib/reference-corpus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Env for every git call that targets one of THIS FILE'S OWN temp repos —
 * never for `runAudit`'s child process, and never for the `git ls-files`
 * call `listCopyableFiles` runs against a source tree. Those two must see
 * the machine's real git config: `runAudit` exercises the audit's real
 * ignore-filtering behaviour, and `listCopyableFiles` must see the real
 * excludes so a private file stays out of the copy the same way it stays
 * out of the real repository.
 *
 * For everything else here — a temp repo this file creates, commits into,
 * and deletes — the machine's own global/system git config must never be
 * consulted. A corporate image with `commit.gpgsign = true` in
 * `/etc/gitconfig`, or a `core.hooksPath` pointing at real hooks, would
 * otherwise make `git commit` inside a THROWAWAY repo fail or run someone
 * else's hook — reproduced directly: a global config carrying both, fed
 * through `GIT_CONFIG_GLOBAL`, made `buildRepoCopy`'s commit fail with
 * "gpg failed to sign the data" and ran the hook's own marker line on
 * stderr, before this env was applied. `GIT_CONFIG_NOSYSTEM` alone does not
 * cover a `GIT_CONFIG_GLOBAL` override some shells already export, so both
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are also pointed at a real,
 * EMPTY file this test file creates (`EMPTY_GIT_CONFIG`). Not the null
 * device: git for Windows refuses it as a config path (`fatal: unable to
 * access '\\.\nul': Invalid argument` — seen on the windows-latest CI leg),
 * while an empty regular file means the same thing on every platform.
 *
 * Config FILES are not the only way in. `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` inject config from the environment with a priority
 * ABOVE the repo-local settings `initGitRepo` writes, and `GIT_TEMPLATE_DIR`
 * makes `git init` copy a template's `hooks/` and `info/exclude` into the
 * new repo — and `commit --no-verify` does not skip a `post-commit` hook.
 * Both were shown to run an outside hook inside the throwaway repo, so the
 * count is pinned to 0, the template variable is removed, and `git init`
 * is given an explicit empty `--template=`.
 */
const EMPTY_GIT_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'verification-audit-gitconfig-'));
const EMPTY_GIT_CONFIG = path.join(EMPTY_GIT_CONFIG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GIT_CONFIG, '');
// Read-only after creation: this file is shared as GIT_CONFIG_GLOBAL/
// GIT_CONFIG_SYSTEM across every temp-repo git call this whole file makes
// (initGitRepo runs once per fixture, many times per test run), and nothing
// in this file is meant to write to it — every `git config` call
// initGitRepo issues is a plain LOCAL write (`git config user.email …`, no
// `--global`/`--system` flag), which lands in the throwaway repo's own
// `.git/config`, never here. Making it 0o444 turns "something wrote to the
// shared file and every git call after that one silently inherited it" from
// a possible cross-test leak into an immediate, loud EACCES at the write
// site.
chmodSync(EMPTY_GIT_CONFIG, 0o444);
afterAll(() => {
  // Windows refuses to unlink a read-only file (EPERM) until the read-only
  // attribute is cleared — chmod back to writable before rmSync, on every
  // platform, rather than relying on rmSync's own best-effort Windows retry.
  try {
    chmodSync(EMPTY_GIT_CONFIG, 0o644);
  } catch {
    // Already gone, or a platform where chmod cannot fail this way — rmSync
    // below still removes the directory either way.
  }
  rmSync(EMPTY_GIT_CONFIG_DIR, { recursive: true, force: true });
});

function buildTempRepoGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Start from NO inherited git variable at all, rather than chasing them one
  // at a time: besides the two above, `GIT_CONFIG_PARAMETERS` injects config
  // too, and `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` /
  // `GIT_OBJECT_DIRECTORY` outrank `cwd` — exported by a wrapper, they would
  // point this file's `git init` / `config` / `add` / `commit` at SOMEBODY
  // ELSE'S repository and write to it. Nothing a throwaway repo needs comes
  // from a `GIT_*` variable, so none is kept.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = EMPTY_GIT_CONFIG;
  env.GIT_CONFIG_SYSTEM = EMPTY_GIT_CONFIG;
  env.GIT_CONFIG_COUNT = '0';
  return env;
}
const TEMP_REPO_GIT_ENV = buildTempRepoGitEnv(process.env);

/**
 * Env for the two calls that deliberately keep the machine's real git
 * CONFIG (see above): everything is inherited except the variables that
 * re-route git to a different repository, index or object store. With one
 * of those exported, `git ls-files` with `cwd: repoRoot` would list some
 * other repository, and the audit child would ask that repository what is
 * ignored.
 */
// The list itself is the production module's (one owner): a second copy here
// would let the module stop dropping a variable while this file stayed green.
function buildRealConfigGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (REPO_ROUTING_GIT_VARS.includes(key.toUpperCase())) delete env[key];
  }
  return env;
}
const REAL_CONFIG_GIT_ENV = buildRealConfigGitEnv(process.env);

describe('Feature: git variables inherited from the caller cannot re-route or reconfigure this file\'s git calls', () => {
  // A clean machine exports none of these, so asserting on the live
  // constants would pass with or without the stripping. The builders are
  // exercised with a hostile base environment instead.
  const hostile: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    GIT_DIR: '/somewhere/else/.git',
    GIT_WORK_TREE: '/somewhere/else',
    GIT_INDEX_FILE: '/somewhere/else/.git/index',
    GIT_OBJECT_DIRECTORY: '/somewhere/else/.git/objects',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath=/somewhere/hooks'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/somewhere/hooks',
    GIT_TEMPLATE_DIR: '/somewhere/template',
    GIT_CONFIG_GLOBAL: '/somewhere/gitconfig',
    GIT_AUTHOR_NAME: 'someone',
  };

  it('a temp-repo git call keeps NO inherited GIT_* variable — only the four this file sets', () => {
    const env = buildTempRepoGitEnv(hostile);
    const gitKeys = Object.keys(env).filter((key) => key.toUpperCase().startsWith('GIT_')).sort();
    expect(gitKeys).toEqual(['GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM']);
    expect(env.GIT_CONFIG_COUNT).toBe('0');
    expect(env.GIT_CONFIG_GLOBAL).toBe(EMPTY_GIT_CONFIG);
    expect(env.GIT_CONFIG_SYSTEM).toBe(EMPTY_GIT_CONFIG);
    expect(readFileSync(EMPTY_GIT_CONFIG, 'utf8')).toBe(''); // a real file, and really empty
    expect(env.PATH).toBe('/usr/bin'); // everything that is not git's is kept
    expect(env.HOME).toBe('/home/someone');
  });

  it('a real-config git call drops every repository-routing variable and keeps the machine\'s git config', () => {
    const env = buildRealConfigGitEnv(hostile);
    for (const key of REPO_ROUTING_GIT_VARS) expect(env[key]).toBeUndefined();
    // Named literally as well: the list above is the production module's own,
    // so if the module ever stopped listing one of these, the loop would stop
    // checking it too.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.GIT_CONFIG_GLOBAL).toBe('/somewhere/gitconfig');
    expect(env.GIT_CONFIG_PARAMETERS).toBe("'core.hooksPath=/somewhere/hooks'");
    expect(env.PATH).toBe('/usr/bin');
  });

  it('the production routing list is exactly the expected eight variables', () => {
    // A sentinel, not a second implementation: every consumer uses the
    // module's export, so removing an entry there would also remove it from
    // every loop that checks it. `GIT_COMMON_DIR` is not decoration — with it
    // inherited, `check-ignore` reads ANOTHER repository's `info/exclude` and
    // can report a file here as ignored, i.e. the audit scans less.
    expect([...REPO_ROUTING_GIT_VARS].sort()).toEqual([
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR',
      'GIT_DIR',
      'GIT_INDEX_FILE',
      'GIT_NAMESPACE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_PREFIX',
      'GIT_WORK_TREE',
    ]);
  });
});

function initGitRepo(dir: string): (...args: string[]) => string {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: TEMP_REPO_GIT_ENV,
    }).trim();
  git('init', '-q', '-b', 'main', '--template=');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  // Belt-and-suspenders alongside TEMP_REPO_GIT_ENV and the commit-time
  // --no-gpg-sign/--no-verify flags below: local config that can never be
  // shadowed by a re-exported env var, and still correct even if a caller
  // someday forgets to pass TEMP_REPO_GIT_ENV to a one-off command.
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  return git;
}

function tempGitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'verification-audit-fixture-'));
  const git = initGitRepo(dir);
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The real C4 shape (`|| true` swallowing a real exit code) — the exact
// pattern class the maintainer's leftover files fed to the detector with no
// baseline entry to excuse it.
const C4_SHAPE = '#!/bin/sh\nsome-command || true\n';

describe('Feature: filterIgnored keeps the audit a function of the tree', () => {
  it('drops an ignored, untracked file from the candidate list', () => {
    const repo = tempGitRepo();
    try {
      mkdirSync(path.join(repo.dir, 'scripts'), { recursive: true });
      writeFileSync(path.join(repo.dir, 'scripts', 'sdlc-fixture.sh'), C4_SHAPE);
      writeFileSync(path.join(repo.dir, '.gitignore'), 'scripts/sdlc-fixture.sh\n');
      expect(filterIgnored(['scripts/sdlc-fixture.sh'], { cwd: repo.dir })).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps the same file once it is no longer ignored', () => {
    const repo = tempGitRepo();
    try {
      mkdirSync(path.join(repo.dir, 'scripts'), { recursive: true });
      writeFileSync(path.join(repo.dir, 'scripts', 'sdlc-fixture.sh'), C4_SHAPE);
      writeFileSync(path.join(repo.dir, '.gitignore'), '# nothing ignored\n');
      expect(filterIgnored(['scripts/sdlc-fixture.sh'], { cwd: repo.dir })).toEqual(['scripts/sdlc-fixture.sh']);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps an untracked file that is not ignored — it is about to be committed, and must still be scanned', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(path.join(repo.dir, '.gitignore'), 'nothing-matches-this/\n');
      writeFileSync(path.join(repo.dir, 'new.sh'), C4_SHAPE);
      expect(filterIgnored(['new.sh'], { cwd: repo.dir })).toEqual(['new.sh']);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps a TRACKED file even when a later .gitignore pattern would otherwise match it (not --no-index)', () => {
    // The bug this filter must not create in the other direction: a file
    // that IS part of the repository (force-added, or simply committed
    // before the pattern was added) must never be dropped just because it
    // shares a path with something unrelated that is meant to stay ignored.
    // `--no-index` gets this wrong — verified directly: with `--no-index`,
    // this same fixture reports the tracked file as ignored (exit 0);
    // without it (the default, index-aware form this module uses), it does
    // not (exit 1). That is why filterIgnored must not pass --no-index.
    const repo = tempGitRepo();
    try {
      mkdirSync(path.join(repo.dir, 'scripts', 'sdlc'), { recursive: true });
      writeFileSync(path.join(repo.dir, 'scripts', 'sdlc', 'tracked.sh'), C4_SHAPE);
      repo.git('add', 'scripts/sdlc/tracked.sh');
      repo.git('commit', '-q', '-m', 'init', '--no-gpg-sign', '--no-verify');
      writeFileSync(path.join(repo.dir, '.gitignore'), 'scripts/sdlc/\n');

      let noIndexReportsIgnored = false;
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', 'scripts/sdlc/tracked.sh'], {
          cwd: repo.dir,
          env: TEMP_REPO_GIT_ENV,
        });
        noIndexReportsIgnored = true; // exit 0 = --no-index says "ignored" (wrong for a tracked file)
      } catch {
        noIndexReportsIgnored = false;
      }
      expect(noIndexReportsIgnored).toBe(true);

      expect(filterIgnored(['scripts/sdlc/tracked.sh'], { cwd: repo.dir })).toEqual(['scripts/sdlc/tracked.sh']);
    } finally {
      repo.cleanup();
    }
  });

  it('answers for the repository at `cwd` even when the caller exports an index that belongs to another repository', () => {
    // `GIT_INDEX_FILE` outranks `cwd`. With it inherited, `git check-ignore`
    // asks the OTHER repository's index whether a path is tracked, so a file
    // that IS tracked here (and matches a later .gitignore pattern) is
    // reported as ignored and silently drops out of the audit — the one
    // direction this filter must never fail in.
    const repo = tempGitRepo();
    let other: ReturnType<typeof tempGitRepo> | undefined;
    const previous = process.env.GIT_INDEX_FILE;
    try {
      other = tempGitRepo();
      mkdirSync(path.join(repo.dir, 'scripts', 'sdlc'), { recursive: true });
      writeFileSync(path.join(repo.dir, 'scripts', 'sdlc', 'tracked.sh'), C4_SHAPE);
      repo.git('add', 'scripts/sdlc/tracked.sh');
      repo.git('commit', '-q', '-m', 'init', '--no-gpg-sign', '--no-verify');
      writeFileSync(path.join(repo.dir, '.gitignore'), 'scripts/sdlc/\n');

      writeFileSync(path.join(other.dir, 'unrelated.txt'), 'x');
      other.git('add', 'unrelated.txt');
      const otherIndex = path.join(other.dir, '.git', 'index');
      expect(existsSync(otherIndex)).toBe(true);

      process.env.GIT_INDEX_FILE = otherIndex;
      expect(filterIgnored(['scripts/sdlc/tracked.sh'], { cwd: repo.dir })).toEqual(['scripts/sdlc/tracked.sh']);
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
      repo.cleanup();
      other?.cleanup();
    }
  });

  it('falls back to returning every path unfiltered outside a git work tree, and warns on stderr exactly once per distinct reason', () => {
    // The fallback direction is safe (scans MORE, never less), but silent
    // otherwise: nothing distinguishes "the filter ran and found nothing
    // ignored" from "the filter never ran". filterIgnored writes one line to
    // stderr when it falls back — never to stdout, so it cannot be mistaken
    // by anything that parses the audit's own report — and only once per
    // distinct (reason, detail) pair per process: the real caller
    // (verification-audit.mjs) calls filterIgnored once per `walk()` site,
    // a dozen-plus times in one run, and the same reason repeating that
    // many times is noise that would hide a second, different failure.
    const dir = mkdtempSync(path.join(tmpdir(), 'not-a-git-repo-'));
    _resetWarningsForTest(); // isolate from whatever an earlier test warned
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(filterIgnored(['anything.sh'], { cwd: dir })).toEqual(['anything.sh']);
      expect(filterIgnored(['something-else.sh'], { cwd: dir })).toEqual(['something-else.sh']);
      const warnings = stderrSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('git ignore filter unavailable'));
      expect(warnings).toHaveLength(1); // same reason both calls — warned once, not twice
      expect(warnings[0]).toMatch(/scanning every path/);
    } finally {
      stderrSpy.mockRestore();
      _resetWarningsForTest(); // leave clean state for whatever test runs next
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns with the check-ignore-failure wording (not the work-tree-fallback wording) when check-ignore itself errors', () => {
    // The OTHER branch: a path outside the repository makes `git
    // check-ignore --stdin -z` fail fatally (exit 128), not the normal
    // "nothing in this batch is ignored" exit 1 handled without a warning,
    // and not the "not a git work tree" fallback tested above. Its message
    // must say "git had not already reported as ignored", never the
    // fallback's plain "scanning every path" — the two are printed by two
    // different call sites in git-ignored-paths.mjs and must not be
    // confused for one another by a test that only exercises one of them.
    const repo = tempGitRepo();
    const outsideTheRepo = path.join(tmpdir(), 'definitely-outside-the-repo.txt');
    _resetWarningsForTest();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // Direction still safe even on this failure path: nothing git failed
      // to report as ignored is dropped, so every candidate is kept.
      expect(filterIgnored([outsideTheRepo, 'a.sh'], { cwd: repo.dir })).toEqual([outsideTheRepo, 'a.sh']);
      const warnings = stderrSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('git ignore filter unavailable'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/scanning every path git had not already reported as ignored/);
    } finally {
      stderrSpy.mockRestore();
      _resetWarningsForTest();
      repo.cleanup();
    }
  });
});

function assertInsideTemp(fullPath: string, tempDir: string): string {
  const resolved = path.resolve(fullPath);
  const tempResolved = path.resolve(tempDir);
  if (resolved !== tempResolved && !resolved.startsWith(`${tempResolved}${path.sep}`)) {
    throw new Error(`refusing to write outside the throwaway copy: ${resolved}`);
  }
  return resolved;
}

/** Every fixture write in the next describe block goes through this. */
function writeInTemp(tempDir: string, rel: string, content: string): string {
  const full = path.isAbsolute(rel) ? rel : path.join(tempDir, rel);
  const resolved = assertInsideTemp(full, tempDir);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
  return resolved;
}

function listCopyableFiles(sourceRoot: string): string[] {
  // Deliberately the DEFAULT env (the machine's real git config), never
  // TEMP_REPO_GIT_ENV: this call must see the real ignore rules — the
  // machine's own `.gitignore` / `.git/info/exclude` / `core.excludesFile`
  // — the same way `git add` would, so a private file stays out of the
  // copy exactly as it would stay out of a real `git add -A`.
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: REAL_CONFIG_GIT_ENV,
  });
  return raw
    .split('\0')
    .filter(Boolean)
    // verification-audit.mjs's detectors only walk tests/, scripts/,
    // .github/workflows/, src/, dashboard/src/, docs/, and read
    // package.json (every `walk(...)` call site and every `read(...)` call
    // in the script) — never dist/ or dashboard/dist/. Both are large,
    // built, and tracked (dist/ ships in the npm/plugin package: see the
    // "Build outputs" comment in .gitignore), so leaving them out of this
    // throwaway copy keeps it fast without changing anything the audit
    // actually sees.
    .filter((rel) => rel !== 'dist' && !rel.startsWith('dist/') && !rel.startsWith('dashboard/dist/'));
}

/**
 * A disposable copy of `sourceRoot`'s current working tree (defaults to
 * this repository), in its own throwaway git repo. Built from `git
 * ls-files` in the source (read-only) and plain file copies — never `git
 * show <ref>:<path>` or `git archive`, which would read committed content
 * instead of what is actually on disk, and would defeat the break-tests
 * below: a mutation to scripts/lib/git-ignored-paths.mjs only reaches this
 * copy because the copy is built from disk, from the same working tree the
 * mutated file is edited in. `sourceRoot` is a parameter (not always
 * `repoRoot`) so the symlink regression test below can point this at a
 * tiny synthetic repo instead of the real one.
 *
 * Only REGULAR files are copied. `git ls-files` lists a symlink's own path
 * like any other entry, and `copyFileSync` FOLLOWS a symlink — it would
 * read and materialize whatever the link points at, ignored or entirely
 * outside the repository, as a plain file in the copy (and then into the
 * copy's own `.git/objects` once committed). `lstatSync` — not `statSync`,
 * which itself follows the link — is what lets a symlink be told apart
 * from a regular file without opening what it points to.
 */
function buildRepoCopy(sourceRoot: string = repoRoot): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'verification-audit-repo-copy-'));
  const dirResolved = path.resolve(dir);
  const repoResolved = path.resolve(repoRoot);
  if (dirResolved === repoResolved || dirResolved.startsWith(`${repoResolved}${path.sep}`)) {
    throw new Error('mkdtemp handed back a path inside the real repository — refusing to build the copy there');
  }
  try {
    populateRepoCopy(dir, sourceRoot);
  } catch (err) {
    // A failed build must not leave a (possibly full) copy of the tree behind.
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

function populateRepoCopy(dir: string, sourceRoot: string): void {
  const copied: string[] = [];
  const skippedNonRegular: string[] = [];
  for (const rel of listCopyableFiles(sourceRoot)) {
    const src = path.join(sourceRoot, rel);
    let stat;
    try {
      stat = lstatSync(src);
    } catch (err) {
      // A staged deletion: indexed (or listed untracked) but gone from disk.
      // Anything else (EACCES, ELOOP, …) would silently shrink the copy.
      if (!['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      continue;
    }
    if (!stat.isFile()) {
      skippedNonRegular.push(rel); // symlink, socket, fifo, … — never followed, never recreated
      continue;
    }
    const dst = assertInsideTemp(path.join(dir, rel), dir);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied.push(rel);
  }

  const git = initGitRepo(dir);
  // Add exactly the files the loop above copied — built from git's OWN
  // listing of the source tree, not `git add -A` over the copy — so the
  // snapshot the audit runs against cannot silently pick up anything this
  // loop did not put there.
  execFileSync('git', ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    cwd: dir,
    input: `${copied.join('\0')}\0`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: TEMP_REPO_GIT_ENV,
  });
  if (skippedNonRegular.length > 0) {
    // Skipping is deliberate; doing it without a trace is not. Printed
    // BEFORE the commit below: if the commit itself throws (a `git` failure
    // partway through building the throwaway copy), this notice must still
    // have been seen — it is the trace that a caller reading only stderr
    // needs, not a footnote that a failed commit could suppress entirely.
    console.warn(`buildRepoCopy: skipped ${skippedNonRegular.length} non-regular entr${skippedNonRegular.length === 1 ? 'y' : 'ies'} (never followed): ${skippedNonRegular.join(', ')}`);
  }
  git('commit', '-q', '-m', 'snapshot of the working tree for verification-audit.mjs', '--no-gpg-sign', '--no-verify');
}

/**
 * `true` for "ignored", `false` for "not ignored" — never a swallowed error. `check-ignore
 * -q <path>` exits 1 for "not ignored"; ANY other exit (128 for a fatal git
 * error, a thrown ENOENT for a bad cwd, …) means the question could not be
 * answered at all, and must not be reported as the same "false" a genuine
 * "not ignored" produces — a caller asserting `false` as a precondition
 * would otherwise pass on a broken git, not on a verified fact.
 */
function isIgnoredAt(cwd: string, rel: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: TEMP_REPO_GIT_ENV });
    return true;
  } catch (err) {
    const status = (err as { status: number | null }).status;
    if (status === 1) return false;
    throw err;
  }
}

function runAudit(cwd: string, args: string[] = []): { code: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', ['scripts/audit/verification-audit.mjs', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: REAL_CONFIG_GIT_ENV,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number | null; stdout?: string; stderr?: string };
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * Whether this platform lets an unprivileged process create a symlink.
 * Windows without Developer Mode or an elevated shell throws EPERM on
 * `symlinkSync` — checked once, at module load, so the describe below can
 * register `it.skip` instead of a test that would fail for a reason
 * unrelated to what it is checking.
 */
/** Repo-relative with `/` on every platform — `path.relative` yields `\\` on Windows. */
function repoRelativePosix(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function symlinksSupported(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'symlink-probe-'));
  try {
    const target = path.join(dir, 'target.txt');
    writeFileSync(target, 'x');
    symlinkSync(target, path.join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

describe('Feature: buildRepoCopy never dereferences a symlink into the copy', () => {
  const canSymlink = symlinksSupported();
  const maybeIt = canSymlink ? it : it.skip;
  if (!canSymlink) {
    // Explains a skip a plain runner list cannot: this platform's process
    // would EPERM on symlinkSync itself (e.g. Windows without Developer
    // Mode or an elevated shell), not on anything this test checks.
    console.warn('skipping the symlink regression test: symlinkSync is not permitted on this platform/user');
  }

  maybeIt(
    'an untracked, non-ignored symlink pointing at an ignored file never lands in the copy, by path or by content',
    () => {
      const MARKER = 'ROUND2-PRIVATE-MARKER-DO-NOT-COPY';
      const src = mkdtempSync(path.join(tmpdir(), 'buildrepocopy-symlink-src-'));
      let copy: string | undefined;
      try {
        initGitRepo(src);
        // secret.txt is ignored and never added — exactly the shape a
        // maintainer's real private file has.
        writeFileSync(path.join(src, '.gitignore'), 'secret.txt\n');
        writeFileSync(path.join(src, 'secret.txt'), MARKER);
        // link-to-secret.mjs is untracked and NOT ignored — `git ls-files
        // --others --exclude-standard` lists it, same as it would list any
        // other new source file about to be added.
        symlinkSync(path.join(src, 'secret.txt'), path.join(src, 'link-to-secret.mjs'));

        copy = buildRepoCopy(src);

        expect(existsSync(path.join(copy, 'link-to-secret.mjs'))).toBe(false);

        const offenders = walkFiles(copy).filter((file) => readFileSync(file, 'utf8').includes(MARKER));
        expect(offenders).toEqual([]);
      } finally {
        rmSync(src, { recursive: true, force: true });
        if (copy) rmSync(copy, { recursive: true, force: true });
      }
    },
  );
});

describe("Feature: verification-audit.mjs does not go red because of the maintainer's local, ignored files", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = buildRepoCopy();
    // Generous on purpose: this copies ~600 files and runs three `git`
    // invocations. Locally ~1-2s, but CI's matrix includes a Windows runner,
    // which can run measurably slower than a local machine under load — a
    // timeout this generous costs nothing when it never fires, and firing
    // wrongly here would fail an otherwise-unrelated PR.
  }, 120_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // The two paths the maintainer's checkout had these files at when the bug
  // this section guards against surfaced. Content is the literal C4_SHAPE
  // this file already defines above (for .sh) and an equivalent minimal
  // workflow carrying the same shape (for .yml, since C4 also scans
  // `.github/workflows/*.yml`) — never read from anywhere in the tree.
  const SH_FIXTURE = 'scripts/sdlc/bootstrap.sh';
  const YML_FIXTURE = '.github/workflows/sdlc-review.yml';
  const WORKFLOW_C4_SHAPE = 'name: fixture\njobs:\n  build:\n    steps:\n      - run: some-command || true\n';
  const NEGATIVE_CONTROL_PATH = 'scripts/not-ignored-fixture.sh';

  afterEach(() => {
    for (const rel of [SH_FIXTURE, YML_FIXTURE, NEGATIVE_CONTROL_PATH]) {
      const full = path.join(tempDir, rel);
      if (existsSync(full)) rmSync(full);
    }
  });

  it('the throwaway copy sits outside the real repository, and writeInTemp refuses to write anywhere else', () => {
    expect(path.resolve(tempDir)).not.toBe(path.resolve(repoRoot));
    expect(path.resolve(tempDir).startsWith(`${path.resolve(repoRoot)}${path.sep}`)).toBe(false);
    expect(() => writeInTemp(tempDir, path.join(repoRoot, 'package.json'), 'x')).toThrow();
    // The same helper still works for a path that IS inside the copy.
    const written = writeInTemp(tempDir, 'zz-guard-probe.txt', 'ok');
    expect(existsSync(written)).toBe(true);
    rmSync(written);
  });

  it('writing the fixtures at the ignored paths leaves `git status --short` byte-identical', () => {
    const before = execFileSync('git', ['status', '--short'], { cwd: tempDir, encoding: 'utf8', env: TEMP_REPO_GIT_ENV });
    writeInTemp(tempDir, SH_FIXTURE, C4_SHAPE);
    writeInTemp(tempDir, YML_FIXTURE, WORKFLOW_C4_SHAPE);
    const after = execFileSync('git', ['status', '--short'], { cwd: tempDir, encoding: 'utf8', env: TEMP_REPO_GIT_ENV });
    expect(after).toBe(before);
  });

  it('precondition: both restored paths are genuinely ignored in the throwaway copy, not merely absent from the index', () => {
    writeInTemp(tempDir, SH_FIXTURE, C4_SHAPE);
    writeInTemp(tempDir, YML_FIXTURE, WORKFLOW_C4_SHAPE);
    for (const rel of [SH_FIXTURE, YML_FIXTURE]) {
      // A throw here means the fixture itself is wrong — must fail loudly,
      // not pass vacuously.
      execFileSync('git', ['check-ignore', '-q', rel], { cwd: tempDir, stdio: ['ignore', 'pipe', 'pipe'], env: TEMP_REPO_GIT_ENV });
    }
  });

  it('stays green with the departed files present on disk, ignored', () => {
    writeInTemp(tempDir, SH_FIXTURE, C4_SHAPE);
    writeInTemp(tempDir, YML_FIXTURE, WORKFLOW_C4_SHAPE);
    // The precondition this test's own name promises: both fixtures are
    // actually there before the audit runs. Without this, deleting the two
    // writeInTemp lines above leaves the test green for an unrelated
    // reason — "an unmodified copy audits clean", true with or without the
    // ignored files, which is not what "stays green with the departed
    // files present" claims.
    for (const rel of [SH_FIXTURE, YML_FIXTURE]) {
      expect(existsSync(path.join(tempDir, rel))).toBe(true);
    }

    // This asserts the WHOLE copied repository's audit exits clean, not just
    // that these two fixtures produce no hit — any other untriaged finding
    // anywhere in the tree also fails this test. That coupling is inherited
    // from what this test needs to prove (the real script, run for real,
    // stays green) and is deliberate; the console.error below is the first
    // thing to read if it goes red.
    const result = runAudit(tempDir);
    if (result.code !== 0) {
      console.error(result.stdout, result.stderr);
    }
    expect(result.code).toBe(0);
    // exit 0 alone would also be true of a gutted filter (every detector's
    // denominator collapsed to zero trips the audit's OWN "broken detector"
    // failure, not this one — but a different mutation could still zero out
    // hits without zeroing denominators). Assert the audit actually looked
    // at something, in the audit's own wording for that failure mode.
    expect(result.stdout).not.toContain('denominator 0');
  }, 60_000);

  it('negative control: the identical fixture shape at a NOT-ignored path makes the audit exit 1 and names that path', () => {
    // Precondition, asserted first: if this path were somehow also ignored,
    // exit 1 below would prove nothing about the detector actually running.
    expect(isIgnoredAt(tempDir, NEGATIVE_CONTROL_PATH)).toBe(false);

    writeInTemp(tempDir, NEGATIVE_CONTROL_PATH, C4_SHAPE);
    const result = runAudit(tempDir);
    expect(result.code).toBe(1);
    // `toBe(1)` alone is satisfied by a gutted filter too: with
    // filterIgnored returning `[]`, every detector's candidate list is
    // empty, every denominator is 0, and the audit exits 1 on ITS OWN
    // "broken detector, not a clean class" branch — never having scanned
    // the fixture at all. `toContain` below is what actually discriminates
    // "exited 1 because it found this path" from "exited 1 for any reason".
    expect(result.stdout).not.toContain('denominator 0');
    expect(result.stdout).toContain(NEGATIVE_CONTROL_PATH);
  }, 60_000);
});

/**
 * The audit script's source with ONE detector's own `record(...)` call
 * statement replaced by a comment: the detector's `walk`/`read` work still
 * runs, but that class never reaches `report`, as if the block had thrown
 * before recording or been edited by accident. A declaration skipped by a
 * condition and a second declaration of another class are covered by their
 * own tests below. The call is located by the class's "---- <cls>:" section
 * marker, not by line number.
 */
function suppressRecordCall(source: string, cls: string): string {
  const startMarker = `/* ---- ${cls}:`;
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`fixture is stale: no section marker for ${cls} in verification-audit.mjs`);
  const recordIdx = source.indexOf('record(', start);
  if (recordIdx === -1) throw new Error(`fixture is stale: no record( call found after the ${cls} marker`);
  // None of the seven detectors' `record(...)` call arguments contain the
  // literal two-character substring `");"` (checked by hand against every
  // call site when this fixture was written — each ends `...');` with no
  // earlier `)` immediately followed by `;`), so the first `);` after
  // `record(` is reliably that call's own closing paren and statement
  // terminator, not a `)` embedded inside one of its string arguments.
  const callEnd = source.indexOf(');', recordIdx);
  if (callEnd === -1) throw new Error(`fixture is stale: unterminated record( call after the ${cls} marker`);
  return `${source.slice(0, recordIdx)}/* record() suppressed by test fixture (tests/audit/verification-audit.test.ts) */${source.slice(callEnd + 2)}`;
}

describe('Feature: the audit fails when an EXPECTED detector never calls record() — not only when its candidate set is empty', () => {
  // A dedicated copy, not the shared `tempDir` above: this suite overwrites
  // scripts/audit/verification-audit.mjs itself, which the other describe
  // block's tests must not see.
  let mutantDir: string;
  let scriptPath: string;
  // The unmodified script. Every test below writes its own mutation of THIS,
  // so a test that fails part-way cannot hand its mutant to the next one.
  let original: string;

  beforeAll(() => {
    mutantDir = buildRepoCopy();
    scriptPath = path.join(mutantDir, 'scripts/audit/verification-audit.mjs');
    original = readFileSync(scriptPath, 'utf8');
  }, 120_000);

  afterAll(() => {
    if (mutantDir) rmSync(mutantDir, { recursive: true, force: true });
  });

  it('a detector prevented from calling record() makes the audit exit 1 and name that detector', () => {
    const mutated = suppressRecordCall(original, 'C6');
    // Precondition: the mutation actually changed something. Without this, a
    // stale marker that silently matched nothing would make the rest of this
    // test pass for the wrong reason (an unmodified script that happens to
    // audit clean), the same shape of false-positive the negative-control
    // test above guards against for filterIgnored.
    expect(mutated).not.toBe(original);
    expect(mutated).toContain('record() suppressed by test fixture');
    writeInTemp(mutantDir, scriptPath, mutated);

    const result = runAudit(mutantDir);
    if (result.code !== 1) {
      console.error(result.stdout, result.stderr);
    }
    expect(result.code).toBe(1);
    // Discriminates "failed because C6 never called record()" from any other
    // reason exit 1 could happen (a real untriaged hit, a broken-detector
    // denominator-0, a crash) — the same discipline the other describe
    // block's negative control uses.
    expect(result.stdout).toContain('C6: detector never ran');
    expect(result.stdout).toContain('record() was never called for it');
    // The other six detectors must still have run normally — this proves
    // the mutation is scoped to C6 alone, not an accident that broke the
    // whole script into some other failure shape.
    for (const cls of ['C1', 'C3', 'C4', 'C5', 'C8', 'C7']) {
      expect(result.stdout).toContain(`${cls}: denominator=`);
    }
  }, 60_000);

  it('a detector whose declaration is skipped by a condition is still expected, and is named', () => {
    const declaration = "detector('C6', (record) => {";
    expect(original.split(declaration).length - 1).toBe(1);
    writeInTemp(mutantDir, scriptPath, original.replace(declaration, `false && ${declaration}`));

    const result = runAudit(mutantDir);
    if (result.code !== 1) console.error(result.stdout, result.stderr);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('C6: detector never ran');
    expect(result.stdout).toContain('C7: denominator=');
  }, 60_000);

  it('two detectors declared under one class do not pass as one: the script refuses to run', () => {
    const declaration = "detector('C7', (record) => {";
    expect(original.split(declaration).length - 1).toBe(1);
    writeInTemp(mutantDir, scriptPath, original.replace(declaration, "detector('C6', (record) => {"));

    const result = runAudit(mutantDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('detector C6 is declared twice');
    expect(result.stdout).not.toContain('Every hit is triaged');
  }, 60_000);
});

describe('Feature: EXPECTED_DETECTORS names exactly these seven classes, by name', () => {
  it('deleting a class from BOTH its declaration and this list at once must still be visible', () => {
    // Path kept in its own variable, not inlined into readFileSync(: C6
    // below flags exactly that inline shape as "reads source and
    // text-matches it", and cannot tell this legitimate read apart from it.
    const realScriptPath = path.join(repoRoot, 'scripts/audit/verification-audit.mjs');
    const realSource = readFileSync(realScriptPath, 'utf8');
    const m = realSource.match(/const EXPECTED_DETECTORS = \[([^\]]*)\];/);
    expect(m).not.toBeNull();
    const listed = m![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(listed).toEqual(['C1', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']);
  });
});

/**
 * `report`/`allHits`/the recorder are private to `createDetectorRegistry()`'s
 * closure — no module-scope name exists for a body to alias or call twice.
 * Proved BEHAVIOURALLY, against a mutated copy of the real script run for
 * real, not by reading the source as text: a source-text check only
 * recognises shapes it was written to look for.
 */
describe("Feature: a detector's result belongs only to the recorder its own wrapper handed it — no alias, no double call, no non-finite denominator survives", () => {
  let mutantDir: string;
  let scriptPath: string;
  let original: string;

  beforeAll(() => {
    mutantDir = buildRepoCopy();
    scriptPath = path.join(mutantDir, 'scripts/audit/verification-audit.mjs');
    original = readFileSync(scriptPath, 'utf8');
  }, 120_000);

  afterAll(() => {
    if (mutantDir) rmSync(mutantDir, { recursive: true, force: true });
  });

  /** Locates `cls`'s own `record(...)` call statement (start, end of `);`). */
  function locateRecordCall(source: string, cls: string): { start: number; end: number } {
    const startMarker = `/* ---- ${cls}:`;
    const sectionStart = source.indexOf(startMarker);
    if (sectionStart === -1) throw new Error(`fixture is stale: no section marker for ${cls} in verification-audit.mjs`);
    const recordIdx = source.indexOf('record(', sectionStart);
    if (recordIdx === -1) throw new Error(`fixture is stale: no record( call found after the ${cls} marker`);
    const callEnd = source.indexOf(');', recordIdx);
    if (callEnd === -1) throw new Error(`fixture is stale: unterminated record( call after the ${cls} marker`);
    return { start: recordIdx, end: callEnd + 2 };
  }

  /**
   * Alias the module-scope `record` before any detector runs, make one
   * normal bound call, then use the alias to overwrite a DIFFERENT class's
   * result. There is no module-scope `record` binding to alias — the line
   * throws a ReferenceError at load, before any detector runs.
   */
  function aliasAndOverwriteMutant(source: string, cls: string, victimCls: string): string {
    const firstMarker = '/* ---- C1:';
    const firstIdx = source.indexOf(firstMarker);
    if (firstIdx === -1) throw new Error('fixture is stale: no C1 section marker found');
    const withAlias = `${source.slice(0, firstIdx)}const rawRecord = record;\n\n${source.slice(firstIdx)}`;

    const { end } = locateRecordCall(withAlias, cls);
    const overwrite = `\n  rawRecord('${victimCls}', 1, [], 'overwrite ${victimCls}');`;
    return `${withAlias.slice(0, end)}${overwrite}${withAlias.slice(end)}`;
  }

  /** A body calling its own bound recorder a second time, same arguments. */
  function duplicateRecordCall(source: string, cls: string): string {
    const { start, end } = locateRecordCall(source, cls);
    const call = source.slice(start, end);
    return `${source.slice(0, end)}\n  ${call} // duplicate call planted by test${source.slice(end)}`;
  }

  /** Replaces `cls`'s own denominator ARGUMENT (whatever expression it was) with `literal`. */
  function forceDenominatorLiteral(source: string, cls: string, literal: string): string {
    const { start } = locateRecordCall(source, cls);
    const afterParen = start + 'record('.length;
    const firstComma = source.indexOf(',', afterParen);
    if (firstComma === -1) throw new Error(`fixture is stale: no comma after record( for ${cls}`);
    return `${source.slice(0, afterParen)}${literal}${source.slice(firstComma)}`;
  }

  /**
   * A body reaching `getReport()` — reachable by the same ordinary
   * module-scope lookup that reaches `detector` — to overwrite a different
   * class's entry after its own legitimate call. Must have no effect: the
   * gate reads its OWN `getReport()` call, and every call hands back a fresh
   * snapshot, never the live store this body's snapshot is a copy of.
   */
  function externalReportWriteMutant(source: string, cls: string, victimCls: string): string {
    const { end } = locateRecordCall(source, cls);
    const injected = `\n  getReport()['${victimCls}'] = { denominator: 1, hits: [], note: 'external write via getReport()' };`;
    return `${source.slice(0, end)}${injected}${source.slice(end)}`;
  }

  it('aliasing the module-scope recorder before any detector runs, then overwriting a different class after a valid bound call, does not exit clean', () => {
    const mutated = aliasAndOverwriteMutant(original, 'C7', 'C8');
    expect(mutated).not.toBe(original);
    expect(mutated).toContain('const rawRecord = record;');
    writeInTemp(mutantDir, scriptPath, mutated);

    const result = runAudit(mutantDir);
    expect(result.code).not.toBe(0);
    // Discriminates "crashed because `record` has no module-scope binding to
    // alias" from any other reason exit 1 could happen.
    expect(result.stderr).toContain('record is not defined');
    // A fabricated C8 report must never reach the gate's own printed output.
    expect(result.stdout).not.toContain('C8: denominator=1');
  }, 60_000);

  it('a detector body that calls its bound recorder twice does not exit clean, naming the class', () => {
    const mutated = duplicateRecordCall(original, 'C7');
    expect(mutated).not.toBe(original);
    writeInTemp(mutantDir, scriptPath, mutated);

    const result = runAudit(mutantDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('C7');
    expect(result.stderr).toContain('called its recorder twice');
  }, 60_000);

  it('a NaN denominator does not exit clean', () => {
    const mutated = forceDenominatorLiteral(original, 'C7', 'NaN');
    expect(mutated).not.toBe(original);
    writeInTemp(mutantDir, scriptPath, mutated);

    const result = runAudit(mutantDir);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('C7: denominator NaN is not a finite number greater than 0');
  }, 60_000);

  it('a zero denominator still exits non-clean, and the message still contains the literal substring "denominator 0" that two other tests in this file key off of', () => {
    const mutated = forceDenominatorLiteral(original, 'C7', '0');
    expect(mutated).not.toBe(original);
    writeInTemp(mutantDir, scriptPath, mutated);

    const result = runAudit(mutantDir);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('denominator 0');
  }, 60_000);

  it("a detector body reaching getReport() to overwrite another class's entry has no effect — getReport() hands back a snapshot, not the live store", () => {
    const mutated = externalReportWriteMutant(original, 'C7', 'C8');
    expect(mutated).not.toBe(original);
    writeInTemp(mutantDir, scriptPath, mutated);

    const result = runAudit(mutantDir);
    // The write itself does not crash anything (getReport IS reachable —
    // unlike the alias mutant above) — it just writes into a copy nothing
    // else reads. C8's real denominator/hits are unaffected, so this is a
    // normal clean run.
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('C8: denominator=1 hits=0');
  }, 60_000);

  it('a body that empties its hits array after recording cannot change the recorded result', () => {
    const resultLine = (out: string) => out.split('\n').find((line) => line.includes(' C1: denominator='));
    writeInTemp(mutantDir, scriptPath, original);
    const baseline = runAudit(mutantDir);
    expect(baseline.code).toBe(0);
    // Precondition: C1 has hits to lose, or clearing the array proves nothing.
    expect(resultLine(baseline.stdout)).not.toContain('hits=0');

    const { end } = locateRecordCall(original, 'C1');
    writeInTemp(mutantDir, scriptPath, `${original.slice(0, end)}\n  hits.length = 0;${original.slice(end)}`);
    const result = runAudit(mutantDir);
    expect(result.code).toBe(0);
    expect(resultLine(result.stdout)).toBe(resultLine(baseline.stdout));
  }, 60_000);

  it('a body that declares another detector fails, naming both classes', () => {
    const declaration = "detector('C1', (record) => {";
    expect(original.split(declaration).length - 1).toBe(1);
    writeInTemp(mutantDir, scriptPath, original.replace(declaration, `${declaration}\n  detector('C3', (other) => other(1, [], 'nested'));`));

    const result = runAudit(mutantDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("detector C3 declared inside C1's body");
  }, 60_000);

  describe('--prune-stale', () => {
    const baselineFile = () => path.join(mutantDir, 'scripts/audit/baseline.json');

    it('leaves baseline.json alone when the gate failed', () => {
      const declaration = "detector('C6', (record) => {";
      expect(original.split(declaration).length - 1).toBe(1);
      writeInTemp(mutantDir, scriptPath, original.replace(declaration, `false && ${declaration}`));
      const before = readFileSync(baselineFile(), 'utf8');
      try {
        const result = runAudit(mutantDir, ['--prune-stale']);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain('C6: detector never ran');
        expect(result.stdout).toContain('--prune-stale skipped');
        expect(readFileSync(baselineFile(), 'utf8')).toBe(before);
      } finally {
        writeFileSync(baselineFile(), before);
      }
    }, 60_000);

    it('still removes a stale entry when the gate passed', () => {
      writeInTemp(mutantDir, scriptPath, original);
      const before = readFileSync(baselineFile(), 'utf8');
      const baseline = JSON.parse(before);
      baseline.hits['C4 scripts/no-such-script.sh:1'] = { class: 'x', reason: 'stale on purpose', triaged: '2026-01-01' };
      writeFileSync(baselineFile(), JSON.stringify(baseline, null, 2));
      try {
        const result = runAudit(mutantDir, ['--prune-stale']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('pruned 1 stale baseline entries');
        expect(Object.keys(JSON.parse(readFileSync(baselineFile(), 'utf8')).hits)).not.toContain('C4 scripts/no-such-script.sh:1');
      } finally {
        writeFileSync(baselineFile(), before);
      }
    }, 60_000);
  });
});

describe('Feature: no *.test.{ts,tsx,mjs} file contains the literal HEAD-colon substring in code', () => {
  // This checks ONE literal shape and says exactly that — not "any test
  // cannot reintroduce this bug". It flags the substring `HEAD:` (built
  // from two joined parts below so this line is not a hit on itself)
  // inside a *.test.{ts,tsx,mjs} file's source, after comments are
  // stripped.
  //
  // What it catches: `git show HEAD:path`, in any quoting that TYPES that
  // substring directly (single quotes, double quotes, or a plain template
  // literal) — because round 1's actual bug, read from a ref this same
  // commit deletes the path at, was exactly that spelling.
  //
  // What it does NOT catch, left unguarded on purpose rather than claimed
  // otherwise: `HEAD~1:path`, `HEAD^{tree}` (no colon), `@:path` (HEAD's
  // own alias), `main@{u}:path`, or the identical bug spelled to dodge a
  // substring scan — `'HEAD' + ':'`, or a template literal that builds the
  // ref from a variable (`` `${ref}:${rel}` ``). All of these are the same
  // underlying defect (a fixture bound to a commit instead of the working
  // tree) that this needle does not see. A regex-based scanner is not a
  // parser; building one is out of proportion to what round 1 shipped.
  //
  // What it can ALSO do: flag an innocent string that happens to contain
  // the substring `HEAD:` in prose unrelated to a git ref (e.g. a fixture
  // asserting `'refs/heads/x HEAD: up to date'`). It cannot tell a git-ref
  // argument from ordinary text. If that ever fires on a real string, the
  // fix is the trick this file already uses on itself: build the string
  // from two joined parts instead of writing the substring inline.
  //
  // Comments ARE exempt (stripped via stripComments before the scan runs):
  // tests/gitignore-scope.test.ts:90 names the same syntax inside a `//`
  // comment, on purpose, as the shape it avoids, and that mention must not
  // itself count as a hit.
  const HEAD_REF_NEEDLE = ['HEAD', ':'].join('');

  // Every *.test.{ts,tsx,mjs} file in the repository, derived from git's
  // OWN view of the tree — `listCopyableFiles(repoRoot)`, the same
  // tracked-plus-untracked-not-ignored listing `buildRepoCopy` builds the
  // throwaway copy from — filtered to the test-file pattern. Deliberately
  // NOT a raw disk walk: a raw walk of repoRoot descends into whatever this
  // machine happens to keep on disk that git ignores — other worktrees
  // under `.codex/worktrees/`/`.claude/worktrees/` (each a full copy of
  // this same test suite, sometimes mid-edit by another process) and the
  // maintainer's own private `scripts/sdlc/*.test.mjs`. Scanning those is
  // exactly the disk-vs-tree defect this whole change exists to remove —
  // this guard's verdict would depend on what happens to be sitting on one
  // machine's disk — and, separately, it is slow. A hand-written directory
  // list has the same failure mode as a hand-written FILE list: it was how
  // the previous version of this scan (tests/ only, walking) missed
  // scripts/verify.test.mjs and scripts/lib/verify-core.test.mjs — the two
  // files the required `SDLC verify` job actually runs
  // (.github/workflows/ci.yml's "SDLC verify" step: `node --test
  // scripts/verify.test.mjs scripts/lib/verify-core.test.mjs`), which the
  // assertion right below pins so that scope cannot silently shrink back.
  function listTestFilesInRepo(): string[] {
    const pattern = /\.test\.(ts|tsx|mjs)$/;
    const out: string[] = [];
    for (const rel of listCopyableFiles(repoRoot)) {
      if (!pattern.test(rel)) continue;
      const full = path.join(repoRoot, rel);
      let stat;
      try {
        stat = lstatSync(full);
      } catch (err) {
        // A staged deletion; any other error would silently shrink the scan.
        if (!['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
        continue;
      }
      if (!stat.isFile()) continue; // symlink, socket, … — same rule buildRepoCopy applies
      out.push(full);
    }
    return out;
  }

  it("includes scripts/verify.test.mjs and scripts/lib/verify-core.test.mjs — the required 'SDLC verify' job's own test files, not just tests/", () => {
    const relPaths = listTestFilesInRepo().map(repoRelativePosix);
    expect(relPaths).toContain('scripts/verify.test.mjs');
    expect(relPaths).toContain('scripts/lib/verify-core.test.mjs');
  });

  it('no *.test.{ts,tsx,mjs} file git tracks or would track (untracked, not ignored) contains the literal HEAD-colon substring in code', () => {
    const offenders: string[] = [];
    for (const file of listTestFilesInRepo()) {
      const stripped = stripComments(readFileSync(file, 'utf8'), file);
      if (stripped.includes(HEAD_REF_NEEDLE)) offenders.push(repoRelativePosix(file));
    }
    expect(offenders).toEqual([]);
  });
});
