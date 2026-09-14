# Implementation-plan evaluation asked about the wrong stage

## Symptom

Actions run 34807191993 authenticated and ran both model cases, but
no-plan-no-build reported that the answer did not name the plan path and
Proof. The other case passed.

## Root cause

The prompt asked what must be produced first for a new feature. The checker
expected the implementation plan, while the documented SDLC starts with
intent and then spec. A local replay on commit 8eea7ee reproduced this
mismatch: the model read contributor and loop instructions, answered intent
first, and exited 0; the checker exited 1. The parsed answer matched the
CLI's final-message file. The original hosted answer was not retained, so
this replay establishes a reproducible cause, not its exact hosted wording.

## Why existing gates missed it

Parser tests validate event extraction. A previous successful model answer
did not establish that the question had only one policy-consistent answer.
The prompt omitted the stage precondition required by its checker.

## Gate correction

The scenario now begins after intent and specification acceptance and asks
for the artifact needed before implementation. The existing requirement to
read project guidance and name the plan path and Proof remains unchanged;
the prompt does not supply those answer terms. Model-backed evaluation must
exercise this scenario. This evaluation concerns contributor behavior, not
product runtime or completion of the hosted SDLC loop.
