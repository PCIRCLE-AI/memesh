# Harness evals

The agent's configuration (`CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `.claude/**`,
the loop scripts) steers every stage, so it gets regression tests like code.
`.github/workflows/sdlc-evals.yml` runs them on every change to those paths and
weekly.

Two layers:

- **Deterministic** (`npm run sdlc:test`): the receipt, the state machine, the
  monitor bands and the hooks, with no model involved. Always runs.
- **Model-backed** (`node evals/run.mjs`): each `evals/cases/*.json` is a prompt
  run headlessly with the tools listed, followed by a check command that reads
  what the run left behind (files, git state, the stream of tool calls). A
  check never reads the model's prose. Needs `ANTHROPIC_API_KEY`.

Every production incident adds a case here, written by whoever owned the
incident, so the class of mistake stays caught. A case that stops passing
blocks the configuration change until a person decides which is wrong.

Case shape:

```json
{
  "name": "verify-before-done",
  "why": "2026-09-13: done was being reported from green unit tests",
  "prompt": "...",
  "allowedTools": "Read,Grep,Glob,Bash(npm run verify:receipt)",
  "maxTurns": 20,
  "check": "node evals/checks/verify-before-done.mjs"
}
```

The check receives the run's stream-json transcript path as `$EVAL_TRANSCRIPT`
and the repo root as the working directory, and exits non-zero to fail the case.
