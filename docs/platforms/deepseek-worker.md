# MeMesh With a Delegate Worker (DeepSeek)

A delegate worker is a model you hand a bounded task to from Claude Code or
Codex. The DeepSeek worker is one: a client runs the task on a remote model —
either as a direct chat call or inside a throwaway sandbox ("Harness") — and
prints a JSON **envelope** with the result.

The worker is **not** a MeMesh host, and it must not become one:

- Its output is untrusted by policy.
- The sandbox has no MCP tools. Its only network peer is a gateway made for
  that one task.
- `memesh serve` listens on loopback only. The worker's machine cannot reach
  it.

So the worker never writes memory. What MeMesh keeps instead is a record of
the **delegation**: what was asked, what came back, and whether you (the
orchestrator — the agent that sent the task) accepted it. You write that
record yourself, on your own machine, from the envelope.

## Recording a delegation

After the worker client returns, save its envelope and the prompt you sent,
then:

```bash
memesh delegation record --envelope envelope.json --prompt-file prompt.txt
```

This stores one `delegation` memory:

| Stored | From |
|---|---|
| Prompt **sha256** (never the prompt text) | `--prompt-file` |
| Model, mode (`direct` or `harness`), `allowed_tools` | the envelope |
| `usage` (prompt, completion and total tokens), `finish_reason`, `ok` | the envelope |
| Verdict, starting at `unreviewed` | `--verdict`, later `verify` |
| `metadata.provenance.source: "deepseek-worker"`, `trust: "untrusted-until-verified"` | set by MeMesh |

The worker's answer (`content`, `parsed`, `final_response`) and its
diagnostics are **not** stored. They are untrusted text. When a result turns
out to be right, write the conclusion yourself with `remember`, in your own
words, and point it at the delegation record.

Recording the same envelope again writes nothing and reports the verdict
already stored.

## The verify flip

Check the worker's result first: read the diff, rerun the tests. Then record
what you found:

```bash
memesh delegation verify delegation-<hash>-<hash> --verdict accepted --note "diff reviewed, tests re-run"
memesh delegation verify delegation-<hash>-<hash> --verdict rejected --note "invented an API"
```

`accepted` sets provenance `trust` to `verified`; `rejected` sets it to
`rejected`. Either way the verdict is added as a new line, so the record keeps
its history.

## What the worker can read

Give the worker memory the same way you give it any other input: as a
read-only file you chose. For example, run `memesh recall "<topic>" --json`
on your machine and pass the output as an input file. No write path leads
back from the sandbox, and none should be added: MeMesh has no HTTP route and
no MCP tool for delegation records, and a test fails if one appears.

Full flag reference: [API Reference → memesh delegation](../api/API_REFERENCE.md#memesh-delegation).
