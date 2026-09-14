# Quiet commit capture gap

## Symptom

MeMesh recorded no commit memories for two days even though work continued.
The missed commits were created with quiet output or with output redirected,
so the PostToolUse hook received no `[branch sha] subject` line to parse.

## Root cause

The hook treated terminal text as the source of truth for whether a commit had
happened. That worked for ordinary `git commit` output, but `git commit -q`,
redirected output, merge, cherry-pick, revert, and scripts can all change Git
state without leaving that line in the hook payload. The no-output path exited
successfully, so the failure looked identical to an irrelevant Bash command.

## Why existing gates missed it

The tests supplied commit-shaped output to the hook. They checked parsing and
database writes, but never made a quiet commit in a real repository and then
ran the shipped hook against the changed `HEAD`. Unit and release checks could
therefore stay green while daily capture produced zero commit entities.

## Fix

For commit-producing commands, the hook now resolves the repository's current
`HEAD` and compares it with a private marker under `MEMESH_DIR`. The marker is
keyed by the real Git common directory, with an independent position for each
linked worktree and a nearest-known-ancestor seed for a new worktree,
contains a per-worktree map of the last observed hashes, and advances atomically only after all
selected entities are stored. The first observation establishes a baseline
without importing existing history. A changed range stores at most the newest
20 commits and records the number omitted. Terminal output may corroborate a
legacy first observation only when its hash equals the independently resolved
`HEAD`; repository state remains the authority when Git is quiet or a wrapper
replays stale output.

Failed commands, a missing repository, the initial baseline, and an unchanged
`HEAD` each leave a queryable outcome record and one bounded diagnostic where
the operator needs it.

Release validation also exposed a race in the candidate's stale-lock recovery:
two recoverers could both inspect a dead owner, then one could rename a new
owner's lock using its stale observation. Token comparison happened too late.
The hook now uses the existing SQLite driver to lock one stable private file
per repository. It never renames or deletes that file; process termination
releases the OS lock, and contention still records an error within the hook's
deadline. The knowledge graph and marker format are unchanged.

## Gate added

The hook regression suite now creates real temporary repositories and proves:

- a quiet commit after the baseline creates the expected commit entity;
- multiple hidden commits are captured as a bounded batch;
- ranges over 20 retain the newest 20 and report the omitted count;
- linked worktrees share the marker while retaining independent positions;
- real merge, cherry-pick, and revert operations are captured; and
- a failed commit-like command writes no entity and records an unchanged head.

Lock regressions hold a real SQLite write lock, verify the hook's bounded error,
kill a lock owner, and run concurrent captures while checking the lock file
was not replaced. Earlier dead-PID fixtures did not exercise that interleaving.

The release live-journey runner also executes the quiet commit path from the
candidate checkout as an isolated process. A separate packed-upgrade journey
installs the tarball and proves its packaged CLI and MCP entry points; the
checkout hook row does not claim installed-host wiring.
