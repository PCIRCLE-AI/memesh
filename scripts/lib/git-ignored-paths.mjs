// Filters a list of repo-relative paths down to the ones git would actually
// track or stage — the same set `treeHash()` (scripts/lib/verify-core.mjs)
// hashes, since that also runs `git add -A` and therefore respects ignore
// rules. Built for scripts/audit/verification-audit.mjs, whose detectors
// walked the filesystem (`fs.readdirSync`) with no git awareness at all: on
// a machine where the departed SDLC-loop files sit on disk as git-ignored,
// untracked local tooling, every detector still saw them, they had no
// baseline entries any more (correctly — they are not in the repository),
// and the audit went permanently red on the one machine that actually runs
// it, while staying green on every fresh clone and in CI. A scan that reads
// the tree must depend on the tree and on the machine's own git ignore rules
// (`.gitignore`, plus the per-machine `.git/info/exclude` and
// `core.excludesFile` that `git check-ignore` also consults) — not on
// whatever untracked local files happen to be sitting in the working copy
// with no ignore rule at all. That per-machine half is bounded to the safe
// direction: a path that is actually part of the repository (in the index)
// is always kept regardless of what any exclude file says — see the
// `--no-index` note below — so a machine-local exclude can only make ONE
// developer's own run scan less than CI does, never CI less than intended.
//
// Deliberately NOT `--no-index`: that flag ignores the index entirely, so it
// reports a TRACKED file as ignored the moment a later `.gitignore` pattern
// happens to match its path (e.g. a force-added file, or simply a pattern
// added after the file was committed) — exactly the file this filter must
// keep scanning, because it is still part of the repository regardless of
// what `.gitignore` says. Plain `git check-ignore` (the default, index-
// aware) does not do that: confirmed against a tracked-but-ignored fixture,
// and exercised end to end against a disposable copy of this repository's
// own tree (never the live checkout), in
// tests/audit/verification-audit.test.ts.

import { execFileSync } from 'node:child_process';

// `check-ignore`'s candidate lists run into the thousands of paths for this
// module's only caller (C4 alone). The default `execFileSync` maxBuffer is
// 1 MiB; a batch that large is plausible, and a truncated stdout would be
// read as "nothing past this point is ignored" — safe (see below) but
// silent unless it also hits the warning path. Set explicitly rather than
// relying on the platform default.
const CHECK_IGNORE_MAX_BUFFER = 64 * 1024 * 1024;

// `cwd` is how this module says WHICH repository it is asking about. A
// handful of git variables outrank `cwd`: with `GIT_DIR` (or an absolute
// `GIT_INDEX_FILE`) exported by a wrapper, both calls below would consult
// some other repository's index and ignore rules and answer for the wrong
// tree. They are dropped from the child's environment; everything else —
// including the machine's git CONFIG, which the filter is meant to honour —
// is inherited unchanged.
export const REPO_ROUTING_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (REPO_ROUTING_GIT_VARS.includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

export function isGitWorkTree(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
      encoding: 'utf8',
    });
    return true;
  } catch (err) {
    // Any failure here — not a git work tree, git missing from PATH, `.git`
    // unreadable, a permissions error — disables the ignore filter below:
    // filterIgnored then returns every path unfiltered, which IS the safe
    // direction (more scanning, never less) for THIS branch — every path,
    // with nothing dropped at all. One line on stderr closes the gap
    // between "the filter ran and found nothing ignored" and "the filter
    // never ran at all", without touching the audit's own stdout contract
    // (nothing parses this module's stderr; see the call site).
    warn(reasonFor(err), 'scanning every path');
    return false;
  }
}

function reasonFor(err) {
  if (err && err.code) return err.code;
  if (err && err.signal) return `signal ${err.signal}`;
  if (err && typeof err.status === 'number') return `exit ${err.status}`;
  return (err && err.message) || 'unknown error';
}

// One line per distinct (reason, detail) pair, per process — not per call.
// filterIgnored's caller (verification-audit.mjs) invokes it once per
// `walk()` site, a dozen-plus times in one run; the same "not a git work
// tree" or "check-ignore exited 128" reason repeating that many times is
// noise that hides whether a SECOND, different failure ever happened.
const warned = new Set();

function warn(reason, detail) {
  const message = `verification-audit: git ignore filter unavailable (${reason}); ${detail}\n`;
  if (warned.has(message)) return;
  warned.add(message);
  process.stderr.write(message);
}

// Test-only: clears the per-process dedupe so a test that exercises the
// fallback more than once, on purpose, can still observe each warning.
// Nothing in this module calls it — one process, one detector run, warn
// once per distinct message is the real behaviour.
export function _resetWarningsForTest() {
  warned.clear();
}

/**
 * Drop every path git ignores; keep everything else (tracked, or untracked
 * and not ignored — the latter is a file someone is about to `git add`, and
 * must still be scanned). Outside a git work tree (no `.git` reachable from
 * `cwd`), falls back to returning every input path unfiltered — today's
 * behaviour — since there is no tree to be a function of.
 */
export function filterIgnored(paths, { cwd } = {}) {
  if (paths.length === 0) return [];
  if (!isGitWorkTree(cwd)) return paths;
  let out;
  try {
    // `--stdin -z`: one process for the whole candidate list instead of one
    // per path (this script's candidate lists run into the thousands of
    // lines for C4 alone). It prints only the paths that ARE ignored — none
    // printed and exit 1 is the normal "nothing in this batch is ignored"
    // case, not a failure, so it is caught and treated as empty output
    // rather than raising past this function.
    out = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd,
      input: `${paths.join('\0')}\0`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      env: gitEnv(),
      maxBuffer: CHECK_IGNORE_MAX_BUFFER,
    });
  } catch (err) {
    // Exit 1 with no output is the normal "nothing in this batch is
    // ignored" case handled above, not a failure. Anything else reaching
    // here — a fatal git error (e.g. exit 128), a maxBuffer overflow
    // (ENOBUFS / ERR_CHILD_PROCESS_STDIO_MAXBUFFER, process killed mid-
    // write), a signal — means git did not finish reporting. Whatever
    // stdout it emitted BEFORE that point is kept, so this scans everything
    // git had not already reported as ignored when it stopped — not
    // literally "everything": paths git had already printed as ignored,
    // earlier in the same batch, are still dropped. The direction is still
    // safe (more scanning, never less), so it is kept rather than treated
    // as fatal, but it is now visible instead of silent.
    const status = err && typeof err.status === 'number' ? err.status : null;
    if (status !== 1) warn(reasonFor(err), 'scanning every path git had not already reported as ignored');
    out = err.stdout ?? '';
  }
  const ignored = new Set(out.split('\0').filter(Boolean));
  return paths.filter(p => !ignored.has(p));
}
