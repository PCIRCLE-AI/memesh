---
title: A forgotten observation on a session snapshot entity stays forgotten after the next Stop
status: accepted
origin: person
author: KT
date: 2026-09-14
issue: https://github.com/PCIRCLE-AI/memesh/issues/346
---

# Intent: A forgotten observation on a session snapshot entity stays forgotten after the next Stop

## Problem

A user can `forget` one observation on an entity (`removeObservation`) without archiving the entity. On the three `session-<id>-*` snapshot entities that `session-summary.js` rewrites with `replace: true` on every Stop, that correction is silently undone on the next Stop: the snapshot is re-derived from the transcript and the removed observation comes back. PR #344 (#322) protected a whole-entity forget (an archived entity is not resurrected); an observation-level forget on an entity that stays `active` has no protection, and nothing detects or reports the resurrection. The gap is documented in a comment above the `if (replace && !isNew && row.status === 'archived')` check in `scripts/hooks/_shared.js` (issue #346).

This is structural, not rare: for as long as the session continues, every observation-level forget on those three entities is guaranteed to be reverted, and the graph then looks exactly as if the user had never corrected it.

## Proposed outcome

A user who forgets an observation on a session snapshot entity does not see it return on a later Stop of the same session. If a design choice makes that impossible for some observation, the user is told at `forget` time rather than corrected silently later.

## Affected users and systems

Anyone using `forget` (MCP tool, CLI `memesh forget`) on `session-<id>-summary`, `session-<id>-files` or `session-<id>-fixes` entities; `scripts/hooks/session-summary.js` and `scripts/hooks/_shared.js` (`captureEntityInner`, the `replace: true` path); the `forget` handler; `memesh doctor` if a detector is added.

## Constraints

- No AI attribution in commits; docs move with the change (`CONTRIBUTING.md`).
- The hook-change protocol applies: real-payload fixture, default-allow on optional fields, stderr-trace every silent exit, end-to-end install test (`CONTRIBUTING.md`, "Pull Requests").
- `docs/api/API_REFERENCE.md` describes `forget`; any change in what `forget` promises changes that document in the same change.
- A fix without an invariant in `scripts/audit/memory-invariants.mjs` can regress silently (`CLAUDE.md`, "The graph is the product").

## Out of scope

- `commit-<sha>` and `pre-compact-<id>` entities: they append, and an observation-level forget already survives there.
- Redesigning how session snapshots are derived from the transcript.

## Open questions

- Should a forgotten observation be remembered as a tombstone the next `replace` honours, or should `replace` on these entities stop being a full overwrite?
- Is "tell the user at forget time that this observation will come back" an acceptable outcome for some cases, or must every forget stick?
