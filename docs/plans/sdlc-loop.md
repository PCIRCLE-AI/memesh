---
title: Adopt the SDLC loop (verify receipt, gates, stage workflows on codex)
status: accepted
spec: none (issue #349; the loop's own installation, written by hand)
generated_by: person
build: manual
---

# Plan: Adopt the SDLC loop

The commit gate this plan introduces asks for a plan on any branch that changes
twenty or more source lines, so the branch that introduces it carries one. It
is the plan for PR #350; `build: manual` tells the state machine the build is
that PR, not a stage to run.

## Files that change

- `scripts/verify.mjs`, `scripts/verify-receipt.mjs`, `scripts/verify.test.mjs` (new): the one verify command; green writes `.verify/receipt.json` bound to the git tree hash; the build step is marked `regenerates` because `dist/` is tracked
- `scripts/sdlc/*.mjs` (new): state machine, stage runner, provider layer (`agent.mjs`: claude, codex, gemini), gh/glab host abstraction, smoke (`smoke.command` for a package with no public origin), monitor (null origin recorded as not evaluated), review runner, git-native gates (`git-gate.mjs`, `git-hooks/`, `install-git-hooks.mjs`), bootstrap
- `.claude/settings.json`, `.claude/hooks/*.mjs`, `.claude/sdlc/prompts/*.md`, `.claude/agents/journey-verifier.md` (new): Claude Code project hooks and stage prompts; `.gitignore` stops ignoring these four paths and `docs/plans/<slug>.md`
- `.github/workflows/sdlc-{loop,review,release,monitor,evals}.yml` (new), `.github/workflows/ci.yml` (modified: `SDLC verify` job on the PR head): GitHub-owned, SHA-pinned actions only
- `sdlc/config.json` (new): every project value (provider codex, verify steps, plan gate paths, smoke command, required checks)
- `package.json` (modified): `verify*`, `sdlc:*` scripts, guarded `prepare` that installs the git hooks
- `scripts/qa/post-release.mjs` (modified): `--skip-machine` for the release receipt on a runner
- `scripts/audit/baseline.json` (modified): triaged audit hits for the new files
- `CLAUDE.md`, `REVIEW.md`, `docs/sdlc/LOOP.md`, `intent/`, `docs/specs/`, `docs/plans/` (new or modified): the rules and the artifact folders; `intent/observation-forget-survives-stop.md` is the first intent (draft)
- `.nvmrc`, `.github/pull_request_template.md` (Coverage table)

## Order of work

1. Verify command and receipt, harness tests green locally.
2. Claude Code hooks, then git-native hooks so codex and people meet the same rule.
3. CI job that reruns verify on the PR head and logs the tree hash.
4. Stage workflows with the provider layer; review on codex; release receipt through `qa:post-release`.
5. Bootstrap (secrets, labels, branch protection) by the owner; first intent accepted afterwards.

## Risks

- A `prepare` script runs in places one forgets (`npm pack --json`, an unpacked tarball, Windows without bash): now node, guarded, stderr only. Riskiest step.
- The loop's token can merge its own build PR on a one-person repository (0 approvals): the build allowlist forbids merge commands, `run-stage` fails a merged request after the fact, bootstrap says so; a machine account for the token is the stronger setup.
- codex's Linux sandbox needs a user namespace with capabilities; the install step relaxes the runner's AppArmor restriction and logs the outcome.
- Not chosen: keeping gates only in Claude Code hooks (codex would bypass them locally); a separate CI workflow file for verify (ci.yml already runs the same steps).

## Proof

- `npm run verify` exit 0, ending `[verify] GREEN. Receipt for tree <hash> written to .verify/receipt.json.`
- `npm run verify:receipt` exit 0 printing `fresh` for that tree
- `npm run sdlc:test` exit 0 (`scripts/sdlc/git-gate.test.mjs`: a real `git commit` refused without a receipt and with a partial index, allowed with a matching receipt; `scripts/sdlc/agent.test.mjs`: provider invocations; `scripts/verify.test.mjs`: red, crash, tree change, regenerate)
- `node scripts/audit/verification-audit.mjs` exit 0
- CI check `SDLC verify` green on the PR, its `[verify] tree <hash>` line equal to the receipt tree quoted in the PR body
- `node scripts/sdlc/smoke-public.mjs --sha <sha of v4.9.4> --version 4.9.4` exit 0 (release receipt path against the registry)

## Neighbouring flows

- The existing CI matrix and release verification gate (unchanged; the new job runs beside them).
- Cutting a release (`CONTRIBUTING.md`): `release:finish` and `publish-npm.yml` are untouched; the loop's release workflow only files a receipt afterwards.
