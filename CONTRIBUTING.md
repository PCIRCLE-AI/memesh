# Contributing to MeMesh

MeMesh is intentionally small. Changes should preserve that shape: a minimal MCP surface, SQLite-backed persistence, and predictable packaging.

## Prerequisites

- Node.js 22.13.0 or newer (see `package.json` `engines.node`)
- npm

## Local Setup

```bash
npm install
npm run typecheck
npm run build
node scripts/run-tests-isolated.mjs
npm run test:packaged
```

`npm run test:packaged` is required for changes that affect packaging, hooks, CLI assets, release automation, or any file included in the published npm tarball.

## Documentation Discipline (PR-review gate)

Documentation is part of the change, not follow-up work. CI's version, generated-artifact, surface-parity, and source-backed documentation gates enforce selected contracts; every description outside those checks still needs reviewer judgment against source.

- Update `README.md` when behavior, installation, or development workflow changes (and re-sync the 2 locale parities — `README.zh-TW.md`, `README.de.md`).
- Update `docs/api/API_REFERENCE.md` when the MCP / HTTP / CLI surface changes (and bump its `**Version**: ` line on a release).
- Update `docs/ARCHITECTURE.md` when module structure, storage behavior, or packaging flow changes (and bump its `**Version**: ` line on a release).
- Read `DESIGN.md` before any dashboard change that touches colour, type, spacing or an interaction, and update it when a token or rule changes. It is derived from `dashboard/src/styles/global.css`; when the two disagree the CSS is what ships, so fix whichever is wrong rather than leaving them apart.
- Keep version metadata coherent: `package.json`, both the root `version` and `packages[""].version` in `package-lock.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` `plugins[].version`, `herdr-plugin.toml`, the `CHANGELOG.md` release header, and the `**Version**:` lines in `CODEMAP.md`, `docs/ARCHITECTURE.md`, and `docs/api/API_REFERENCE.md`. Run `node scripts/check-version-coherence.mjs` to check these anchors. `npm version` updates the lockfile; hand-editing `package.json` does not.
- After ANY change to `.claude-plugin/`, `scripts/hooks/`, `skills/`, or version files, run `npm run build` so `dist/skills-manifest.json` regenerates. Otherwise `memesh doctor` reports `Skills + hooks integrity FAIL` and users see "memesh setup is incomplete" in their dashboard. CI's `Doctor` step catches this before merge.

`CLAUDE.md` carries the same rules in the form an AI coding assistant reads. It is a pointer file — this document is the source of truth for anything that applies to a human contributor.

## Pull Requests

- Use the project's `.github/pull_request_template.md` — it loads automatically when you open a PR. Fill in the "Docs synced" checklist; an unfilled checklist is treated as not-ready-for-review.
- Keep pull requests focused. Smaller changes are easier to review and safer to release.
- Include tests for behavior changes when practical.
- Note any packaging or migration impact in the PR description.
- If your change affects the published artifact, mention that `npm run test:packaged` passed.
- If your change touches `scripts/hooks/*.js` or any hook payload consumer, follow the hook-change protocol: real-payload fixture (capture from a live Claude Code transcript), default-allow on optional fields, stderr-trace every silent exit, end-to-end install test in a real Claude Code session, `memesh doctor` hook-activity green post-install.

## Cutting a Release

A release is one operation, not three commands:

```bash
git checkout main && git pull        # the release PR is already merged
npm run qa:pre-release               # the enumerable gates, in one door
# Produce fresh .qa/codex-report.json and .qa/claude-report.json receipts.
npm run release:finish -- --dry-run  # what it would do, or every reason it refuses
npm run release:finish
npm run qa:post-release              # after the publish workflow is green
```

`npm run qa:pre-release` runs the build, requires the independent UI review below against that build, then runs the `verify:artifact` sequence and
`audit:memory`, prints each step's real exit code, and ends with the list of
checks it could not run — the interactive live journey among them. It is not a
substitute for reading that list.

### Required UI review and repair before release

CI, translation-key parity, page-load smoke tests, and screenshots alone do not
prove that the interface is understandable or truthful. Before **every release**,
a reviewer who authored none of the candidate changes must exercise the actual
candidate dashboard in a browser. Keep the report and replay evidence private in
`.qa/`; never commit internal review notes or fabricate a passing report.

Review **every advertised locale and every top-level tab**, derived from
`dashboard/src/lib/i18n.ts` and `dashboard/src/App.tsx`, including dialogs,
notifications, backend-originated diagnostics, and empty/loading/error states.
The mandatory review includes:

- **Plain language:** users can understand what happened, its impact, and their
  next action. Internal paths and raw technical diagnostics belong in expandable
  details, not routine homepage warnings.
- **Complete localization:** labels, explanations, errors and backend-originated
  text use the selected language. Missing keys and silent English fallback are
  findings, not successful localization. Product names and code are not prose.
- **Truthful, actionable diagnostics:** warnings reflect a verified problem that
  affects the user. Test an unpublished candidate beside an older installed CLI:
  do not recommend an unavailable upgrade. Test isolated databases: do not claim
  installations share data without verifying their actual database identity.
- **Feature/navigation alignment:** each visible feature, tab and term matches
  the current release's behavior and documentation. Explicitly review whether
  "Knowledge Graph" still serves a supported user task; neither keep it merely
  because it renders nor remove underlying relationships merely because search
  uses FTS. Resolve unclear product intent with the owner before release.
- **Failure paths and effects:** exercise empty data, loading, unavailable server,
  invalid actions and recovery. Read back state changes and clean only disposable
  test data; do not mutate the owner's memories or settings to obtain a pass.

Record findings first. Each finding needs a fix, a focused regression check
(including a controlled failing case where practical), and a browser retest.
Refreeze after changes and obtain a fresh independent review on the new candidate.
Unresolved findings, missing coverage, or unavailable language expertise block
release; do not downgrade them to a warning just to publish.

`npm run qa:ui-review` checks `.qa/ui-review.json`, and `qa:pre-release` invokes
it after building and before the full suite. `release:finish` already runs `qa:pre-release` fresh, so it cannot use
successful build/tests instead of this requirement. The report contract is:

- `schema_version: "memesh-ui-review/v1"`, exact 40-character `revision`,
  `dirty: false`, ISO `reviewed_at` within 24 hours, and actual browser/server
  `runtime` identification, and `dashboard_sha256` of the served candidate's
  `dashboard/dist/index.html` (checked against the current build).
- Distinct `reviewer` and `implementer` identities, `independent: true`, and
  `verdict: "PASS"`. The owner verifies the reviewer authored no changed paths;
  retain `reviewer_basis` identifying the independent assignment/non-authorship
  evidence. These fields are attestations, not authenticated identity proof.
- `checks`: one entry per `REQUIRED_CHECKS` ID in `scripts/qa/ui-review.mjs`.
  This includes text contrast and readable type sizes, plus responsive layout:
  inspect actual computed colours (including opacity), small-screen wrapping,
  keyboard focus, and zoom. A palette unit test alone is not browser evidence.
- `coverage`: one entry per advertised `locale`/`tab` pair, with rendered-state
  observations, not just a translation-key or HTTP response check.
- Each check/coverage entry has `status: "PASS"`, a concrete `observation`, an
  `replay` array of steps, `expected` and `actual` visible results, an
  `evidence` file under `.qa/`, and that file's `sha256`. Retain browser replay
  steps, visible output, test setup, and relevant effect/failure readbacks.
- `findings`: the complete inventory (an empty array only if none were found).
  Each has `id`, `fix`, `resolved: true`, and `retest` with the same observation,
  evidence, digest and status fields. Do not drop earlier findings after repair.

The validator proves only report completeness, file digests and candidate
binding. It cannot judge language quality, authenticate authorship, or prove
that observations are true. The release owner must inspect the evidence and
have the independent reviewer replay the claims. It grants no release authority.

`release:finish` requires separate v3 live receipts for both hosts on the exact
clean commit, produced within the previous 24 hours. The Claude receipt comes
from `npm run qa:live-journey -- --host claude --out
.qa/claude-report.json`. The Codex receipt must come from an installed-plugin
SessionStart lifecycle run and include registration, lease renewal, resume-
generation supersession, model-visible delivery, disconnect, and durable
offline fallback. The ordinary `--host codex` journey installs the candidate
plugin into a caller-created disposable authenticated `CODEX_HOME`, verifies
the installed cache bytes, and exercises its real SessionStart/SessionEnd
lifecycle; the narrower account-free harness mode cannot satisfy that gate. See
[`docs/platforms/agent-messaging.md`](docs/platforms/agent-messaging.md#repeatable-owner-run-live-checks).

`npm run qa:post-release` is the half a fresh-clone gate cannot do: it asks the
registry whether the version is really published and really `latest`, installs
it from the registry into a throwaway prefix and runs it, runs the shipped
capture hooks against a throwaway graph (the `capture` receipt: post-commit must
store one commit and session-summary one session insight), and then asks whether
this machine is on that version. It changes nothing — every remediation it
finds is printed for you to run. Registry propagation lags a green publish by
minutes, so a first `registry` FAIL right after the workflow goes green is
worth re-running once before investigating.

`npm run release:finish` (`scripts/finish-release.mjs`) creates the tag and the
GitHub Release in a single `gh release create` call, and that release — not a
bare tag push — is what triggers `.github/workflows/publish-npm.yml`. It refuses
unless it is on `main`, the tree is clean, local `HEAD` matches `origin/main`,
`vX.Y.Z` is not already taken locally or on `origin`, `gh` is authenticated, and
`CHANGELOG.md` has a `## [X.Y.Z]` section to publish as the release body. Every
reason it refuses is printed at once, so a `--dry-run` tells you the whole list
rather than the first item.

Pick the release body deliberately. With no `--notes-file` it publishes the
whole `## [X.Y.Z]` CHANGELOG section — complete, and long: 4.6.1's was 26,355
characters. The bodies actually published for 4.6.1 and 4.6.0 were 2,790 and
1,949 characters of curated highlights, written by hand and passed with
`--notes-file <path>`.
Either is a reasonable release; the command prints the first lines of whichever
it resolved before it acts, and after the call it is too late to look.

The tag it creates is lightweight rather than annotated. Nothing in this
repository reads the difference — there is no `git describe` anywhere, and
`git tag --list`, `git ls-remote --tags` and CI's `fetch-tags: true` treat both
alike. No ruleset needs pausing either: `Protect release and benchmark tags`
covers `refs/tags/v*` with `deletion` and `non_fast_forward` rules only, so tag
*creation* is not what it blocks.

Why it is one call rather than `git tag` + `git push` + `gh release create`: the
middle of that sequence leaves a pushed tag with no release. Nothing publishes,
because `publish-npm.yml` fires on `release: published` — and the version
coherence gate now sees the tag and reports ok, so `main` would look released
while npm did not have it, with nothing left looking.

Between merging the release PR and creating the release, `main` declares a
version nobody can install, and `npm run verify:release` on `main` FAILS by
design with "main declares X.Y.Z and no vX.Y.Z tag exists". That failure is
`scripts/lib/published-version.mjs` working, not a bug to investigate — v4.2.11
sat in that state for five days. Finish the release; do not go looking into the
red.

Then watch the workflow run it prints. npm's registry lags a green publish by
minutes: `npm view` still answering with the previous version is the registry
catching up, not a failed publish, and a following `npm install` failing with
`ETARGET` is npm's local metadata cache, which `--prefer-online` gets past.

## Security

Do not open public issues for vulnerabilities. Use the private reporting process in [SECURITY.md](SECURITY.md).
