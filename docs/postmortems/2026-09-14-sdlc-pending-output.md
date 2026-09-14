# SDLC pending output prevented the first spec stage

## Symptom

After the accepted intent merged, Actions run 34782680665 failed. Its pending
job succeeded, but no spec job or PR was created.

## Root cause

The workflow passed a JSON pending-stage list through a job output into a
downstream matrix. The runner suppressed that output with:

```text
Skip output 'items' since it may contain secret.
```

The downstream stage therefore had no usable list. The exact secret-mask
match was not inspected; credential contents are not needed to correct the
workflow's dependence on this transport.

## Why existing gates missed it

Scanner and stage tests exercised each script, but did not exercise the
GitHub runner's handling of job outputs. The earlier hosted run had no pending
stage and did not prove that a nonempty list could reach a stage.

## Gate added

Pending items remain in a runner-local file and execute sequentially within
the same job. Process-level tests cover empty and malformed lists, ordering,
argument handling and stopping after failure. These tests do not emulate
GitHub secret masking; hosted acceptance requires a new successful run and
readback of the resulting spec PR.
