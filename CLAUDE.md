# Contributing to MeMesh — agent instructions

Use this file when changing the repository. For using or installing MeMesh,
follow the product documents below. Keep the architecture small: reuse the
existing implementation and introduce abstractions only for current needs.

## Read the relevant source of truth

| Task | Read |
|---|---|
| Contribution requirements and documentation updates | [CONTRIBUTING.md](CONTRIBUTING.md) |
| SDLC stages, plans, and verification receipts | [docs/sdlc/LOOP.md](docs/sdlc/LOOP.md) |
| Independent review | [REVIEW.md](REVIEW.md) |
| Modules, storage, and packaging | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| MCP, HTTP, and CLI contracts | [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md) |
| Dashboard appearance and interaction | [DESIGN.md](DESIGN.md) |
| Product and installation | [README.md](README.md), [llms-install.md](llms-install.md) |
| Using MeMesh as an agent | [AGENTS.md](AGENTS.md) |
| Security reporting | [SECURITY.md](SECURITY.md) |
| Release history | [CHANGELOG.md](CHANGELOG.md) |
| Issue tracker, triage, and domain vocabulary | [issue tracker](docs/agents/issue-tracker.md), [triage labels](docs/agents/triage-labels.md), [domain](docs/agents/domain.md) |

## Plan and verify

Non-trivial changes start from `docs/plans/<slug>.md` with a **Proof** section.
Follow the SDLC stages and review requirements in the documents above.
The source-line threshold and verification steps are configured in
`sdlc/config.json`; consult that file rather than duplicating its values here.

```bash
npm run typecheck
node scripts/run-tests-isolated.mjs --maxWorkers=1
npm run verify
npm run verify:receipt
```

`npm run verify` must exit 0 and report a green receipt for the current tree.
Check the receipt before committing or pushing. Stage exactly the verified
files; a receipt for the whole working tree does not cover a partial commit.
Never write `.verify/` by hand or bypass the gates. On failure, report the
failing step and fix the cause; do not weaken a test to obtain a pass.

`npm run verify:journeys` runs the configured journey steps but writes no full
verification receipt. `npm run verify:release` checks release prerequisites;
neither command alone establishes deployment or user-visible success.

For a bug fix, confirm that the regression check fails before the fix or with
an equivalent controlled fault, then passes on the candidate. Report actual
exit codes and relevant output. A filtered log, test count, or receipt alone
does not prove a user journey: exercise the affected runtime and read back
the required effects before claiming it works.

## Test and data safety

- Run Vitest through `scripts/run-tests-isolated.mjs`. Direct `npm test` can
  use the real MeMesh database. Keep the suite's existing serial execution
  settings: test files share a database and concurrent writers can conflict.
- Do not set `MEMESH_DB_PATH` for the suite. Tests must be able to exercise
  the missing-database path; the wrapper owns environment isolation.
- `npm run test:coverage` reports in-process coverage. Spawned CLI and hook
  processes may show zero coverage despite executable tests; inspect their
  callers and tests before treating zero as an untested path.
- Before a release claim or after a memory-layer fix, run the read-only
  `npm run audit:memory`, or target an explicit database with
  `node scripts/audit/memory-invariants.mjs --db <path>`.
- `entities_fts` is contentless FTS5. Deletion requires the exact text
  originally indexed, or stale search tokens can remain.
- Use disposable data for mutation tests and clean only task-owned resources.

## Keep changes reviewable

- Use a short-lived branch and a pull request to `main`; never push directly
  to `main`. Stage files by name, never with `git add -A` or `git add .`.
- Use `<type>(<scope>): <subject>` commit messages. Omit AI attribution,
  generated-by text, and co-author trailers.
- Follow `CONTRIBUTING.md` for packaging, hook changes, documentation updates,
  and releases. Update the authoritative document when behavior changes.
- Keep independent reviewers separate from authors. Give each reviewer the
  complete diff and executable checks; a specialist's focus narrows questions,
  not access to changed files. Include simplification in the review.
- Delegate bounded work only when it helps. Writers use separate worktrees
  and disjoint paths; the integrating contributor inspects each diff.
- Keep private notes, transcripts, credentials, and local operational details
  untracked. The SDLC intent, spec, and plan artifacts are reviewable project
  contracts; publish only the material needed for that contract.
- Report findings before verdicts, distinguish tested boundaries from missing
  evidence, and retain runtime verification as a separate requirement from CI.
