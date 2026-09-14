---
title: MeMesh v4.10.1 release validation
status: draft
---

# Plan: MeMesh v4.10.1 release validation

## Files that change

- `scripts/hooks/post-commit.js` and capture-liveness source: capture quiet commits from Git state and record failures.
- `src/knowledge-graph.ts`, `src/core/serializer.ts`, and `scripts/hooks/_shared.js`: preserve observation-level forget through Stop and untrusted imports.
- Existing QA, release checks, and their tests: validate core memory journeys, package upgrades, isolation, and cleanup.
- API documentation, incident reports, version manifests, and generated artifacts: match the release behavior.

## Order of work

1. Integrate the existing product fixes and reproduce their failure paths.
2. Verify the fixed candidate and review the affected callers.
3. Align version metadata, validate packaged installation and upgrade, and complete the existing release checks.

## Risks

Git worktrees can share capture state. Stop can overwrite a user's correction.
Imported metadata can conflict with local decisions. Test subprocesses must not
inherit user Git hooks or write to the user's memory database.

## Proof

- `npm run verify` — exit 0.
- `node scripts/run-tests-isolated.mjs tests/hooks/post-commit.test.ts tests/hooks/session-summary.test.ts tests/core/export-import.test.ts tests/audit/memory-invariants.test.ts tests/qa/core-live-journeys.test.ts` — exit 0.
- `npm run qa:live-journey -- --core-only` — exit 0; all core rows include success, failure, effect readback, and cleanup.
- `npm run test:packaged:upgrade` — exit 0; previous memories remain readable after upgrade and a controlled installer failure.

## Neighbouring flows

Whole-entity archive remains respected. Explicit remember can restore a removed
observation. Ordinary commits and append-style capture retain their behavior.
