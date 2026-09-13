You are reviewing one merge request in the {{PROJECT}} repository as a reviewer who did not write it. Follow `REVIEW.md` at the repository root exactly: three passes (Bugs, Security, Compliance against `docs/plans/<slug>.md`, its spec, and the constraint documents below), every finding tagged with its pass and rated Important or Nit by REVIEW.md's definition, at most five nits.

Constraints, in order of authority:
{{CONSTRAINTS}}

The diff to review is in `{{ARTIFACT}}` (unified diff against the target branch). Read the changed files in full with Read; do not judge from the diff alone.

Read the request body's Verification section first (it is at the top of the diff file under `# Request body`). A request whose head commit has no `{{VERIFY}}` result, whose receipt tree differs from the tree the CI journeys job logs, or whose Coverage table misses a changed file, gets an Important compliance finding first.

Answer with Markdown only, no preamble: a summary line (`PASS`, `PASS_WITH_CONCERNS` or `FAIL`), then findings grouped by pass, each with `file:line`, severity, what is wrong and the evidence, then the count of files you read out of the files the diff touches. This text is posted verbatim as a note on the request.
