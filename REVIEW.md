# Review instructions

Applied to every pull/merge request by the review workflow (the host's SDLC review job, running `scripts/sdlc/review.mjs` with the provider in `sdlc/config.json`) and by any reviewer, human or agent. The agent that wrote a change never approves it and runs on a different model than the reviewer; acceptance is a person merging, under whatever branch protection the repository set in bootstrap step 3 (an approval count of 0 on a one-person repository means the person merging is the approval).

## Passes

Run three passes over the complete diff and tag every finding with its pass:

- **Bugs**: logic errors, broken edge cases, regressions in a flow the diff did not intend to touch, error paths that swallow failure (`catch {}` with no record, `|| fallback`, `?? default` that hides a missing value), background paths that can exit 0 without leaving a result.
- **Security**: sign-in, sessions, tokens and scopes, redirect URIs, user-supplied input reaching SQL, shell, file paths or templates, secrets or internal paths in logs and error messages, new or upgraded dependencies, anything that widens what an agent bearer can do.
- **Compliance**: the change matches its plan (`docs/plans/<slug>.md`: files, Proof, neighbouring flows), the spec and the product contract (the constraint documents listed in `sdlc/config.json` → `constraints`), and `AGENTS.md` if present. A diff that changed a test to pass is a compliance finding, not a nit.

## What Important means here

Reserve **Important** for a finding that would break a user flow, leak data, breach a policy or the plan, or let a red result look green. Everything about naming, style, comment wording and file layout is a **Nit**.

## Verification is part of the review

Read the PR's Verification section. If it does not carry a `pnpm verify` result for the head commit, or the receipt tree it quotes differs from the `[verify] tree <hash>` line in the CI job's "Golden journeys" step for the same head commit (the CI job checks out the PR head, not GitHub's merge commit, so the two hashes are comparable), that is an Important compliance finding on its own. Do not take "tests pass" from the description; take it from the check run.

## Cap the nits

Report at most five nits per review; summarize the rest as a count.

## Do not report

Generated files (build output, lockfiles), anything CI already enforces (lint, typecheck, the security baseline, absence assertions), and `.verify/` which is never committed.

## When a finding repeats

A mistake that a review flags for the second time goes into `CLAUDE.md` under "Things Claude gets wrong" in the same PR, so the next session reads it before it can repeat it.
