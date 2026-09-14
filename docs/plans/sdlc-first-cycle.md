---
title: Make the first accepted intent reach a reviewable specification
status: draft
build: manual
---

# First useful SDLC cycle

## Outcome

The accepted intent for observation-forget-survives-stop reaches a draft spec
pull request. The specification remains subject to independent review and a
person's acceptance. This change does not implement the forget behavior.

## Changes

- Keep the pending-stage list within one Actions job and execute it in order,
  reusing the scanner and stage runner. Do not transmit the JSON list as a
  cross-job output or weaken secret masking.
- Record an empty list as no work. Refuse malformed input, missing required
  credentials, and failed stages explicitly. Stop after a failed stage.
- Publish artifact branches with ordinary Git push; preserve a conflicting
  remote branch. Do not add model credits to commits, PR bodies or review
  headings. An empty review response is a failure.
- Keep raw loop/review model records on the runner; publish diagnostics and
  findings instead. Remove generator attribution from spec/plan templates
  and the prompts that fill them.
- Do not pass provider or repository credentials to package installation.
  Persist Codex login during setup; filter known model credential variables
  to the selected provider, with repository token variables reserved for build.
- Select named models in the existing configuration: smaller models for
  bounded drafting and implementation, a different model for planning and
  independent review. This is routing, not a token-budget guarantee.

## Proof

- `npm run sdlc:test` exercises ordered real subprocess execution, no work,
  invalid input and first-failure termination; shell-like data cannot become
  shell commands.
- A local bare Git remote accepts initial artifact publication and rejects a
  conflicting second attempt with its original commit unchanged.
- Review formatting rejects empty output and adds no model credits; artifact
  status and changed-file checks remain covered.
- `npm run verify` exits 0 for the exact candidate tree.
- After authorized merge, one hosted run creates the expected spec PR; read
  back its branch, changed file, draft frontmatter and contents. Without that
  run, hosted behavior remains unverified.

## Risks and limits

Sequential execution stops at the first failed stage, leaving later items for
inspection and a subsequent run. Existing remote branches are never replaced
by force. Credentials, branch-protection policy, product fixes, broader golden
journey coverage and release promotion are outside this change.
