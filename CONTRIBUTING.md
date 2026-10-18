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

- Update `README.md` when behavior, installation, or development workflow changes (and re-sync the 1 locale parity — `README.zh-TW.md`).
- Update `docs/api/API_REFERENCE.md` when the MCP / HTTP / CLI surface changes (and bump its `**Version**: ` line on a release).
- Update `docs/ARCHITECTURE.md` when module structure, storage behavior, or packaging flow changes (and bump its `**Version**: ` line on a release).
- Keep version metadata coherent: `package.json`, both the root `version` and `packages[""].version` in `package-lock.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` `plugins[].version`, the `CHANGELOG.md` release header, and the `**Version**:` lines in `CODEMAP.md`, `docs/ARCHITECTURE.md`, and `docs/api/API_REFERENCE.md`. Run `node scripts/check-version-coherence.mjs` to check these anchors. `npm version` updates the lockfile; hand-editing `package.json` does not.
- After ANY change to `.claude-plugin/`, `scripts/hooks/`, `skills/`, or version files, run `npm run build` so `dist/skills-manifest.json` regenerates. Otherwise `memesh doctor` reports `Skills + hooks integrity FAIL`. CI's `Doctor` step catches this before merge.

`CLAUDE.md` carries the same rules in the form an AI coding assistant reads. It is a pointer file — this document is the source of truth for anything that applies to a human contributor.

## Pull Requests

- Use the project's `.github/pull_request_template.md` — it loads automatically when you open a PR. Fill in the "Docs synced" checklist; an unfilled checklist is treated as not-ready-for-review.
- Keep pull requests focused. Smaller changes are easier to review and safer to release.
- Include tests for behavior changes when practical.
- Note any packaging or migration impact in the PR description.
- If your change affects the published artifact, mention that `npm run test:packaged` passed.
- If your change touches `scripts/hooks/*.js` or any hook payload consumer, follow the hook-change protocol: real-payload fixture (capture from a live Claude Code transcript), default-allow on optional fields, stderr-trace every silent exit, end-to-end install test in a real Claude Code session, `memesh doctor` hook-activity green post-install.

## Cutting a Release

An explicit release-owner decision may reuse valid baseline evidence plus
affected deltas. Record that decision privately
in `.qa/release-evidence-reuse.json`; never commit it or rewrite an old failed
receipt as a passing run. The mapping names `version`, the clean candidate's
`revision` and `tree`, `authority.decidedBy` and `authority.decision`, `uiSkip` (a legacy Dashboard-waiver marker),
the `g6` applicability rationale, separate `hosts.codex` and `hosts.claude`
rationales, and retained `concerns`. Its `evidence` entries each carry `scope`
(`g6`, `codex`, or `claude`), `path`, `sha256`, and the source-to-candidate
`mapping`. Both hosts and G6 require source entries; changed or missing sources
are rejected. Without this explicit mapping, the normal checks below apply.

Approved reuse is printed as `REUSED_WITH_CONCERNS`, never as a fresh native or
full-suite PASS. Build, source/security/version checks, packed-candidate smoke,
memory audit, main/clean-tree/remote/tag checks and publication channels remain
required. A failed native report for the same candidate cannot be hidden by
reuse. UI omission is printed as `SKIP`, not PASS.

A release is one operation, not three commands:

```bash
git checkout main && git pull        # the release PR is already merged
npm run qa:pre-release               # the enumerable gates, in one door
# Produce fresh .qa/codex-report.json and .qa/claude-report.json receipts.
npm run release:finish -- --prerelease --dry-run
# After owner authorization, publish the trial through the existing workflow:
npm run release:finish -- --prerelease
npm run qa:post-release -- --dist-tag next
```

The prerelease publishes the exact version to npm `next` and verifies that
`latest` stays unchanged. Explicit `@next` or version installs opt into the trial;
ordinary npm installs continue using `latest`. The plugin marketplace follows
`main`, so this npm tag separation does not isolate plugin users after the merge.

Retain green post-release and core/live-host journey evidence for the same
candidate, then observe at least one working day with the capture-liveness
check passing. After owner authorization to promote, clear the GitHub
prerelease flag: `gh release edit v<version> --prerelease=false`. The release
workflow's `promote` job then moves the npm `latest` dist-tag — npm is never
changed from a local machine. Wait for that run to finish (up to about 15
minutes, the job's timeout) before reading back both states — `gh release
view v<version>` and
`npm view @pcircle/memesh dist-tags` — then rerun `npm run qa:post-release`
in its default `latest` mode.

- A version can be promoted only while it is the current `next` dist-tag and newer than `latest`.
- The `promote` job exists from the first release tagged after it was added — a release event runs the workflow file from the tagged commit, so an earlier release cannot be promoted this way.
- If `latest` did not move, read the `promote` job's log, fix the cause, and re-run that run.

Without `--prerelease`, `release:finish` retains the stable `latest` behavior;
do not use that mode to skip trial observation for a new candidate.

`npm run qa:pre-release` runs the build, `verify:artifact` and `audit:memory`,
reports their real exits and names boundaries not exercised. The standalone
Dashboard and its browser-review gate were removed in 4.11.0. Native Mod or MCP
form changes still need independent review and evidence at the affected host;
reuse valid evidence for unchanged behavior.

`release:finish` requires separate v4 live receipts for both hosts on the exact
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
registry whether the version is published at the selected tag (`latest` by
default, or `next` during the trial), installs
it from the registry into a throwaway prefix and runs it, runs the shipped
capture hooks against a throwaway graph (the `capture` receipt: post-commit must
store one commit and session-summary one session insight), and then asks whether
this machine is on that version. It uses a disposable installation and graph; it does not upgrade the owner’s
installation or repair the owner’s data. Suggested remediations are printed
for you to run. Registry propagation lags a green publish by
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

If a prerelease exists but npm publication failed, retry its unchanged tag with
`gh workflow run publish-npm.yml -f release_tag=vX.Y.Z`. This accepts only an
existing non-draft prerelease and publishes to `next`; it does not move tags or
promote `latest`. `prepublishOnly` still runs the full artifact gates once.

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
