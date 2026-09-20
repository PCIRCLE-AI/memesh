/**
 * `.gitignore` exceptions must not re-include a subtree over the global rules.
 *
 * This is a public repository. `benchmarks/*` + `!benchmarks/longmemeval/` lets
 * git descend into the one benchmark directory whose files are tracked. Written
 * instead as the recursive `!benchmarks/longmemeval/**`, it silently overrode
 * `.env`, `.env.*` and `data/` for that whole subtree — because in gitignore
 * the LAST matching pattern wins, and a recursive negation matches deeper than
 * the rules above it.
 *
 * That is not a hypothetical directory. `benchmarks/longmemeval/REPRODUCE.md`
 * tells strangers to download a dataset into `benchmarks/longmemeval/data/`,
 * and the benchmark reads an API key. A recursive negation there makes
 * `git add -A` stage a contributor's key and 500 MB of corpus into a public
 * repo, with no warning.
 *
 * These cases pin both directions: the secrets stay ignored, and the files that
 * are supposed to be trackable still are. Checking only the first would pass on
 * a `.gitignore` that ignores the entire benchmark directory.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Is `p` ignored by git?
 *
 * Deliberately WITHOUT `-v`. `git check-ignore -v` exits 0 whenever a pattern
 * matches — including a NEGATION, which means the opposite of ignored. A first
 * version of this helper used `-v` and read exit 0 as "ignored", so under the
 * recursive-negation bug it reported `.env` as safely ignored while
 * `check-ignore -v` was in fact printing `!benchmarks/longmemeval/**` as the
 * matching rule. Measured, with the bug reintroduced:
 *
 *   git check-ignore -v --no-index …/.env  -> exit 0, rule `!benchmarks/…/**`
 *   git check-ignore    --no-index …/.env  -> exit 1, no output
 *
 * The plain form prints only genuinely-ignored paths, so exit status alone is
 * the honest answer.
 */
function isIgnored(p: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', p], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false; // exit 1 = not ignored
  }
}

describe('Feature: .gitignore keeps secrets out of the benchmark subtree', () => {
  it.each([
    'benchmarks/longmemeval/.env',
    'benchmarks/longmemeval/.env.local',
    'benchmarks/longmemeval/data/longmemeval_s.json',
    'benchmarks/longmemeval/nested/deeper/.env',
  ])('ignores %s', (candidate) => {
    expect(isIgnored(candidate)).toBe(true);
  });

  it('still lets the tracked benchmark files be tracked', () => {
    // The other direction. `benchmarks/*` excludes the parent, so without the
    // `!benchmarks/longmemeval/` exception git never descends and every one of
    // these becomes untrackable — a fix for the leak that breaks the benchmark
    // is not a fix.
    const tracked = execFileSync('git', ['ls-files', 'benchmarks/longmemeval'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

    expect(tracked.length).toBeGreaterThan(0);
    for (const file of tracked) {
      expect(isIgnored(file)).toBe(false);
    }
  });

  it('has no recursive negation under benchmarks/', () => {
    // The specific shape that caused it. A directory exception is enough —
    // `benchmarks/*` only matches direct children, so everything below
    // `benchmarks/longmemeval/` is reachable once git descends into it.
    // The working file, not `git show HEAD:` — this has to fail before the
    // commit that would leak, not after it.
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).not.toMatch(/^!benchmarks\/.*\*\*/m);
  });
});

describe('Feature: maintainer-local development-tooling patterns are anchored to the repository root', () => {
  // `intent/`, `evals/`, `sdlc/`, `.claude/`, `REVIEW.md` and `CLAUDE.local.md`
  // (no leading `/`, no internal `/`) match a name at ANY depth, not just at
  // the repo root. `intent` is already a product term
  // (scripts/hooks/user-prompt-intent.js), `benchmarks/longmemeval/` shows
  // nested data directories are a real shape this repo grows, and the
  // product installs hooks into `.claude/` (a `tests/fixtures/.claude/`
  // fixture would silently vanish from `git status` and from the tree
  // `.verify/receipt.json` binds to — the required `SDLC verify` check would
  // stay green over a tree missing the very file the change added).
  //
  // NOT included here: `benchmarks/evals/...`. That path IS ignored, but by
  // the separate, pre-existing, deliberately-designed `benchmarks/*` +
  // `!benchmarks/<name>/` allow-list two blocks above (verified: it ignores
  // `benchmarks/anything/` identically, with or without this describe block's
  // patterns). Asserting it here would test that unrelated rule, not this one.
  it.each([
    'src/intent/foo.ts',
    'src/memory/intent/classifier.ts',
    'skills/intent/SKILL.md',
    'tests/evals/foo.test.ts',
    'src/sdlc/mod.ts',
    'dashboard/src/sdlc/x.tsx',
    'packages/core/REVIEW.md',
    'src/REVIEW.md',
    'src/hooks/CLAUDE.local.md',
    'tests/fixtures/.claude/settings.json',
    // The five departed workflow files are now named explicitly in
    // .gitignore, not matched by a `sdlc-*.yml` glob — a future PUBLIC
    // workflow that happens to start with `sdlc-` must stay trackable.
    '.github/workflows/sdlc-verify.yml',
    '.github/workflows/sdlc-anything-new.yml',
  ])('does not ignore the ordinary source path %s', (candidate) => {
    expect(isIgnored(candidate)).toBe(false);
  });

  it('still ignores the maintainer-local paths at the repository root', () => {
    // The other direction, same reason as the benchmarks pair above: a fix
    // that un-ignores everything named `intent` or `sdlc` anywhere is not a
    // fix — the root-level maintainer-local tree must stay ignored.
    for (const p of [
      '.claude/settings.json',
      'CLAUDE.local.md',
      'scripts/sdlc/lib.mjs',
      'sdlc/config.json',
      'evals/README.md',
      'intent/README.md',
      'docs/sdlc/LOOP.md',
      'docs/specs/README.md',
      'docs/plans/README.md',
      'REVIEW.md',
      // The five workflow files .gitignore now names explicitly — see the
      // comment above them for why this replaced a `sdlc-*.yml` glob.
      '.github/workflows/sdlc-evals.yml',
      '.github/workflows/sdlc-loop.yml',
      '.github/workflows/sdlc-monitor.yml',
      '.github/workflows/sdlc-release.yml',
      '.github/workflows/sdlc-review.yml',
      '.verify/receipt.json',
      '.sdlc-run/foo.json',
    ]) {
      expect(isIgnored(p)).toBe(true);
    }
  });
});
