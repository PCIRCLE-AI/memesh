import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import {
  getProjectName,
  canonicalRemoteLocator,
  _clearProjectNameCache,
} from '../../src/core/paths.js';

const require = createRequire(import.meta.url);
// The hook-side mirror. Loading the JS module directly lets us assert the two
// implementations agree — a divergence would silently split project identity
// between the writers (hooks) and readers (core).
// _shared.js is plain JS with no type declarations
const shared = require('../../scripts/hooks/_shared.js');

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function makeRepo(remoteUrl?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-proj-'));
  // Real fs paths on macOS tmp are symlinked (/var → /private/var); resolve so
  // `git rev-parse --show-toplevel` and our basename comparisons line up.
  const real = fs.realpathSync(dir);
  git(real, ['init']);
  git(real, ['config', 'user.email', 'test@example.com']);
  git(real, ['config', 'user.name', 'Test']);
  if (remoteUrl) git(real, ['remote', 'add', 'origin', remoteUrl]);
  return real;
}

describe('canonicalRemoteLocator', () => {
  const cases: [string, string][] = [
    ['https://github.com/PCIRCLE-AI/memesh-llm-memory.git', 'github.com/PCIRCLE-AI/memesh-llm-memory'],
    ['git@github.com:PCIRCLE-AI/memesh-llm-memory.git', 'github.com/PCIRCLE-AI/memesh-llm-memory'],
    ['ssh://git@GITHUB.COM/PCIRCLE-AI/memesh-llm-memory.git', 'github.com/PCIRCLE-AI/memesh-llm-memory'],
    ['ssh://git@github.com:22/PCIRCLE-AI/memesh-llm-memory.git', 'github.com/PCIRCLE-AI/memesh-llm-memory'],
    ['https://github.com:443/PCIRCLE-AI/memesh-llm-memory.git', 'github.com/PCIRCLE-AI/memesh-llm-memory'],
    ['https://user:secret@host.example/Owner/Repo.git', 'https://host.example/Owner/Repo.git'],
    ['ssh://git@host.example:2222/Owner/Repo.git', 'ssh-absolute://git@host.example:2222/Owner/Repo.git'],
    ['https://host.example:8443/Owner/Repo.git', 'https://host.example:8443/Owner/Repo.git'],
    ['alice@git.example:repo.git', 'ssh-relative://alice@git.example/repo.git'],
    ['bob@git.example:repo.git', 'ssh-relative://bob@git.example/repo.git'],
    ['alice@git.example:/repo.git', 'ssh-absolute://alice@git.example/repo.git'],
    ['ssh://alice@git.example/repo.git', 'ssh-absolute://alice@git.example/repo.git'],
  ];
  for (const [url, expected] of cases) {
    it(`${url} → ${expected}`, () => {
      expect(canonicalRemoteLocator(url)).toBe(expected);
    });
  }
  it('returns null for empty and local filesystem remotes', () => {
    expect(canonicalRemoteLocator('')).toBeNull();
    expect(canonicalRemoteLocator('   ')).toBeNull();
    expect(canonicalRemoteLocator('/local/repo.git')).toBeNull();
    expect(canonicalRemoteLocator('C:/work/repo.git')).toBeNull();
    expect(canonicalRemoteLocator('C:\\work\\repo.git')).toBeNull();
    expect(canonicalRemoteLocator('\\\\server\\share\\repo.git')).toBeNull();
    expect(canonicalRemoteLocator('file:///local/repo.git')).toBeNull();
  });

  it('the hook mirror produces identical slugs', () => {
    for (const [url, expected] of cases) {
      expect(shared.canonicalRemoteLocator(url)).toBe(expected);
    }
  });
});

describe('getProjectName — layered git identity', () => {
  const created: string[] = [];
  beforeEach(() => _clearProjectNameCache());
  afterEach(() => {
    for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('uses the git remote slug, not the directory name (location-independent)', () => {
    const repo = makeRepo('git@github.com:PCIRCLE-AI/canonical-name.git');
    created.push(repo);
    // The directory basename is a random tmp name, NOT "canonical-name".
    expect(path.basename(repo)).not.toBe('canonical-name');
    expect(getProjectName(repo)).toMatch(/^canonical-name~[0-9a-f]{32}$/);
  });

  it('a subdirectory resolves to the SAME identity as the repo root (fixes the split)', () => {
    const repo = makeRepo('https://github.com/x/whole-repo.git');
    created.push(repo);
    const sub = path.join(repo, 'backend', 'src');
    fs.mkdirSync(sub, { recursive: true });
    _clearProjectNameCache();
    expect(getProjectName(sub)).toMatch(/^whole-repo~[0-9a-f]{32}$/);
    expect(getProjectName(repo)).toBe(getProjectName(sub));
  });

  it('keeps same-basename repositories on different remote namespaces isolated', () => {
    const ownerA = makeRepo('https://github.com/owner-a/shared.git');
    const ownerB = makeRepo('git@github.com:owner-b/shared.git');
    const otherHost = makeRepo('https://gitlab.example/owner-a/shared.git');
    created.push(ownerA, ownerB, otherHost);
    const identities = [getProjectName(ownerA), getProjectName(ownerB), getProjectName(otherHost)];
    expect(new Set(identities).size).toBe(3);
    for (const identity of identities) expect(identity).toMatch(/^shared~[0-9a-f]{32}$/);
  });

  it('normalizes standard HTTPS and SSH spellings of one remote to one identity', () => {
    const https = makeRepo('https://github.com/Owner/CaseSensitiveRepo.git');
    const ssh = makeRepo('git@GITHUB.COM:Owner/CaseSensitiveRepo.git');
    created.push(https, ssh);
    expect(getProjectName(https)).toBe(getProjectName(ssh));
  });

  it('keeps generic SSH users and relative-vs-absolute repository paths isolated', () => {
    const relativeAlice = makeRepo('alice@git.example:repo.git');
    const relativeBob = makeRepo('bob@git.example:repo.git');
    const absoluteAlice = makeRepo('alice@git.example:/repo.git');
    created.push(relativeAlice, relativeBob, absoluteAlice);
    expect(new Set([
      getProjectName(relativeAlice),
      getProjectName(relativeBob),
      getProjectName(absoluteAlice),
    ]).size).toBe(3);
  });

  it('keeps distinct generic SSH paths that differ only by .git isolated', () => {
    const withoutSuffix = makeRepo('alice@git.example:/srv/repo');
    const withSuffix = makeRepo('alice@git.example:/srv/repo.git');
    created.push(withoutSuffix, withSuffix);
    expect(getProjectName(withoutSuffix)).toMatch(/^repo~[0-9a-f]{32}$/);
    expect(getProjectName(withSuffix)).toMatch(/^repo~[0-9a-f]{32}$/);
    expect(getProjectName(withoutSuffix)).not.toBe(getProjectName(withSuffix));
  });

  it('one remote identity converges across root, subdir, symlink, and git worktree', () => {
    const repo = makeRepo('https://github.com/Owner/worktree-case.git');
    created.push(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'fixture']);
    const sub = path.join(repo, 'nested');
    fs.mkdirSync(sub);
    const link = `${repo}-link`;
    fs.symlinkSync(repo, link);
    created.push(link);
    const worktree = `${repo}-worktree`;
    git(repo, ['worktree', 'add', '--detach', worktree]);
    created.push(worktree);

    const identities = [repo, sub, link, worktree].map((cwd) => {
      _clearProjectNameCache();
      return getProjectName(cwd);
    });
    expect(new Set(identities)).toEqual(new Set([identities[0]]));
  });

  it('never exposes remote user-info in the project identity', () => {
    const repo = makeRepo('https://private-user:private-password@github.com/Owner/safe-name.git');
    created.push(repo);
    const identity = getProjectName(repo);
    expect(identity).toMatch(/^safe-name~[0-9a-f]{32}$/);
    expect(identity).not.toContain('private-user');
    expect(identity).not.toContain('private-password');
  });

  it('bounds a long readable label so the complete routing field is at most 200 chars', () => {
    const longLabel = 'r'.repeat(190);
    const repo = makeRepo(`https://github.com/Owner/${longLabel}.git`);
    created.push(repo);
    const identity = getProjectName(repo);
    expect(identity.length).toBe(200);
    expect(identity).toMatch(/~[0-9a-f]{32}$/);
  });

  it('falls back to the repo root basename when there is no remote', () => {
    const repo = makeRepo(); // no remote
    created.push(repo);
    expect(getProjectName(repo)).toMatch(new RegExp(`^${path.basename(repo)}~[0-9a-f]{32}$`));
  });

  it('keeps same-basename no-remote git repositories at different roots isolated', () => {
    const parentA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-git-pa-')));
    const parentB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-git-pb-')));
    created.push(parentA, parentB);
    const repoA = path.join(parentA, 'shared');
    const repoB = path.join(parentB, 'shared');
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);
    git(repoA, ['init']);
    git(repoB, ['init']);
    expect(getProjectName(repoA)).not.toBe(getProjectName(repoB));
  });

  it('keeps a no-remote git worktree on the primary repository identity', () => {
    const repo = makeRepo();
    created.push(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'fixture']);
    const worktree = `${repo}-worktree`;
    git(repo, ['worktree', 'add', '--detach', worktree]);
    created.push(worktree);
    expect(getProjectName(worktree)).toBe(getProjectName(repo));
  });

  it('a non-git directory gets basename plus a hash of its real path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nogit-'));
    const real = fs.realpathSync(dir);
    created.push(real);
    const name = getProjectName(real);
    expect(name).toMatch(new RegExp(`^${path.basename(real)}~[0-9a-f]{32}$`));
  });

  it('two same-named non-git directories resolve to TWO identities', () => {
    // ~/a/notes vs ~/b/notes — the collision this layer exists to close. The
    // symptom of the old bare-basename rule was the other directory's
    // memories appearing in recall.
    const parentA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pa-')));
    const parentB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pb-')));
    created.push(parentA, parentB);
    const notesA = path.join(parentA, 'notes');
    const notesB = path.join(parentB, 'notes');
    fs.mkdirSync(notesA);
    fs.mkdirSync(notesB);
    const idA = getProjectName(notesA);
    const idB = getProjectName(notesB);
    expect(idA).not.toBe(idB);
    // Both still carry the human-readable basename up front.
    expect(idA.startsWith('notes~')).toBe(true);
    expect(idB.startsWith('notes~')).toBe(true);
  });

  it('the same non-git directory resolves to ONE identity, even via a symlink', () => {
    // Codex, Claude Code and Gemini all spawn against the same directory —
    // possibly through different path spellings. realpath collapses them.
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-same-')));
    created.push(real);
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    created.push(link);
    const direct = getProjectName(real);
    _clearProjectNameCache();
    const viaLink = getProjectName(link);
    expect(viaLink).toBe(direct);
  });

  it('two case-spellings of the same directory resolve to ONE identity', () => {
    // macOS and Windows default to case-insensitive filesystems, where
    // `~/Notes` and `~/notes` are the same directory. The JS realpathSync
    // returns whatever case the caller typed, so identity depended on the
    // spelling — realpathSync.native returns the on-disk case. On a
    // case-sensitive filesystem (Linux CI) the mis-spelling is simply a
    // different, absent path, and that branch asserts exactly that.
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-CaseFold-')));
    created.push(real);
    const base = path.basename(real);
    const swapped = path.join(path.dirname(real), base.toLowerCase() === base ? base.toUpperCase() : base.toLowerCase());
    const direct = getProjectName(real);
    _clearProjectNameCache();
    if (fs.existsSync(swapped)) {
      // Case-insensitive filesystem: both spellings are one directory and
      // must be one project — for core and for the hook mirror.
      expect(getProjectName(swapped)).toBe(direct);
      _clearProjectNameCache();
      expect(shared.getProjectName(swapped)).toBe(direct);
    } else {
      // Case-sensitive filesystem: the scenario cannot occur; pin that the
      // probe really was decisive rather than silently passing.
      expect(() => fs.realpathSync(swapped)).toThrow();
    }
  });

  it('a nonexistent cwd still resolves to basename+hash — deleted cwd must never break capture', () => {
    // realpathSync throws ENOENT here; the catch falls back to path.resolve.
    // Replacing that catch with a rethrow used to leave the suite green while
    // violating the stated invariant (same rule as the git layers above).
    const ghost = path.join(os.tmpdir(), `memesh-ghost-${process.pid}`, 'gone');
    expect(fs.existsSync(ghost)).toBe(false);
    const core = getProjectName(ghost);
    expect(core).toMatch(/^gone~[0-9a-f]{32}$/);
    // The mirror must take the identical fallback.
    _clearProjectNameCache();
    expect(shared.getProjectName(ghost)).toBe(core);
  });

  it('the hook mirror resolves identically for every layer', () => {
    const withRemote = makeRepo('git@github.com:o/mirror-check.git');
    const noRemote = makeRepo();
    const nonGit = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ng-')));
    created.push(withRemote, noRemote, nonGit);
    for (const cwd of [withRemote, noRemote, nonGit]) {
      _clearProjectNameCache();
      const core = getProjectName(cwd);
      expect(shared.getProjectName(cwd)).toBe(core);
    }
  });
});
