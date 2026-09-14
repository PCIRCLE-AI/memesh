---
title: Restore default-branch CI failure rate below the control band
status: draft
origin: monitor
metric: ci_failure_rate_main
author: MeMesh monitoring loop
date: 2026-09-14
---

# Intent: Restore default-branch CI failure rate below the control band

## Problem

At `2026-09-14T05:27:13.920Z`, the deterministic monitor reported:

> "50% of the last 20 runs on the default branch failed"

The supplied report, also present in `.sdlc-run/breach.json`, records `ci_failure_rate_main: 0.5`, tier `propose`: 10 unsuccessful conclusions out of 20 eligible runs. `scripts/sdlc/monitor.mjs` requests the latest 20 **push workflow runs** on configured default branch `main`, across workflows, then excludes pending, cancelled and skipped conclusions. This is not 20 commits or 20 matrix jobs. `sdlc/config.json` bands inclusively at 0.20 (log), 0.35 (diagnose), and 0.50 (propose), with minimum sample 5.

**Leading diagnosis, provisional: a release-state gate is correctly rejecting an unfinished 4.10.0 release.** Local evidence supports this more directly than a flaky test or external outage:

- `package.json:3` declares `4.10.0`. `git tag --list 'v4.10*'` returned no tags; older tags through `v4.9.4` are visible. This proves only local tag state, not remote publication state.
- First-parent history includes `d25e7dea`, “Merge pull request #320 from PCIRCLE-AI/release/v4.10.0”, dated September 11 locally. The release bump therefore precedes subsequent main pushes.
- `scripts/check-version-coherence.mjs:224` uses `GITHUB_REF_NAME`, so main pushes enforce the published-version check. `scripts/lib/published-version.mjs:90` supplies this diagnostic text (source text, **not a retrieved CI log**):

  > main declares ${pkgVersion} and no `v${pkgVersion}` tag exists

- `.github/workflows/ci.yml` runs `npm run verify:release` in the build matrix and SDLC verification. `CONTRIBUTING.md`, “Cutting a Release”, explicitly documents this failure between merging a release bump and creating its release, including a previous five-day 4.2.11 occurrence. If sampled logs show the 4.10.0 diagnostic with tags fetched, this is a repeat of that release-process failure, not evidence that the check should change.

The requested `git log --oneline -20` also shows these alternative leads:

- `63432a71`, “test(sdlc): the hook test commits as a developer, not as the CI runner”, records that inherited `GITHUB_ACTIONS` allowed a commit whose refusal the test expected. Its commit message says “Harness evals and SDLC verify red on the previous push.” This is historical author evidence, not independently retrieved runner output. It was included in merge `6a8e4200` (#350), so it cannot explain later failures without further evidence; earlier feature-branch failures are outside this metric's push-to-main sample.
- `aa681932`, “fix(release): isolate npm cache and narrow repair errors”, and `202cf69f`, “refactor(release): centralize isolated npm cache”, landed in `e0ed398d` (#348). `docs/postmortems/2026-09-13-isolated-suite-npm-cache.md` describes `EPERM` during nested `npm pack` against the maintainer's cache despite an isolated HOME. Matching cache-path permission errors on older sampled SHAs would support recurrence; this is an environment-isolation defect, not inherently random flakiness. The fix is already present locally.
- The other postmortem, `2026-09-13-dashboard-auto-repair-permission.md`, concerns misleading repair UI errors, with no established connection to this CI breach. Latest merge `72cb3e53` (#353) changes only an accepted intent's status, offering no direct runtime-defect explanation.

**Evidence limit:** failing run IDs, jobs, attempts, timestamps and logs could not be retrieved. Both `gh run list` and the monitor-equivalent read-only request `gh api 'repos/PCIRCLE-AI/memesh/actions/runs?branch=main&event=push&per_page=20'` failed; the remote tag lookup also failed. Actual host output was:

> error connecting to api.github.com
> check your internet connection or https://githubstatus.com

The standalone remote tag command exited 1. These errors establish this diagnosis environment's access failure, not a GitHub outage at breach time. No CI log lines can honestly be quoted. MeMesh is unavailable here; no remembered evidence was used.

## Proposed outcome

The unchanged monitor reports `ci_failure_rate_main` tier `ok`: failure rate **strictly below 0.20**, with at least 5 eligible conclusions under the existing sampling rules. For 20 eligible runs, at most 3 may be unsuccessful; 4/20 still breaches. Merely falling below 0.50 does not restore the normal band.

The failed-run signatures are accounted for with run URLs, SHAs, attempts and runner exit codes, and subsequent main verification demonstrates that the identified cause is resolved. Historical failures aging out alone are not proof of a repair.

## Affected users and systems

Contributors and release owners lose reliable CI feedback and release readiness. Affected systems potentially include GitHub Actions, version-coherence/release gates, SDLC verification and npm packaging. Consumers awaiting 4.10.0 may be affected if the publication gap is confirmed; installed-product impact is unproven.

Public readiness and drift were not evaluated because `origin` is null. MeMesh is distributed through npm; these entries establish neither downtime nor successful deployment.

## Constraints

- Never weaken, skip or remove a check, alter tests to suppress the signal, raise control thresholds, or exclude failing workflows to obtain green.
- Production changes require the release gate and owner authorization. Follow `CONTRIBUTING.md`'s release runbook: pre-release verification, independent UI/live-host evidence, authorized `release:finish`, and post-release verification. A diagnosis does not authorize publishing or bypassing the missing-tag guard.
- Preserve existing isolation, data rights and authentication boundaries. No credentials, user memories, test state or release state are changed by this diagnosis.
- This task changes only this draft intent. No tests or builds were run because diagnosis is read-only apart from the requested artifact.

## Out of scope

Implementing fixes, changing tests or monitoring configuration, rerunning workflows, publishing, creating tags, or configuring a public origin.

## Open questions

- What are the exact 20 sampled run IDs and conclusions at detection time? Recover that historical window, not just the latest moving window, and group failures by workflow, step, SHA and attempt.
- Did failing main jobs emit the missing `v4.10.0` diagnostic? Was that tag absent remotely at detection, or absent only from a checkout? Is the version actually published and latest in npm? Remote reads were unavailable.
- Do any sampled failures instead match the npm-cache postmortem, the already-fixed hook environment mismatch, or a different assertion? Local history cannot attribute the ten failures.
- Is this flaky or external? Neither is established. Opposite outcomes on the same SHA with unchanged inputs would support intermittency; repeated identical assertions or missing-tag errors would support a deterministic defect or release-state violation. Runner timeouts with steady progress, or contemporaneous checkout/registry/network failures across unrelated SHAs plus provider incident evidence, would support infrastructure trouble. Same-SHA success after a tag or registry change is changed external state, not by itself a flaky test.
- Who owns completing or correcting the release state, if confirmed, and what release prerequisites remain unsatisfied?
