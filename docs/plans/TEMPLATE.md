---
title: <title from the spec>
status: draft
spec: docs/specs/<slug>.md
generated_by: sdlc-loop
build: pending
---

# Plan: <title>

## Files that change

- `path` (new | modified | deleted): what changes here

## Order of work

1. Smallest vertical slice that works end to end.
2. ...

## Risks

What this can break. The riskiest step. What was not chosen, and why.

## Proof

Machine-checkable only. Each line is a command with expected exit code, the
exact name of a Playwright test, a unit-test file with the behavior it covers,
or a screenshot compared with a named mock.

- `npm run verify` exit 0
- Playwright: `<exact test name>` in `apps/web/e2e/...`

## Neighbouring flows

The two existing user flows nearest this change; the journey verifier walks them too.
