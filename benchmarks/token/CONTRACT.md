# Token-usage benchmark — measurability verdict and frozen contract

Issue #251, the first task of the token-efficiency roadmap (#250). This
document answers one question before anything else is built: **can the
token usage of a real agent-host session be obtained authoritatively and
attributed to one arm of an experiment?** Only because the answer is yes does
the second half of this file freeze the contract a benchmark must satisfy.

Nothing here is a product feature. `usage-probe.mjs` and `validate.mjs` are
evidence tooling; they ship in the repository so the verdict can be replayed,
not in the npm package.

## Part 1 — Measurability verdict: `MEASURABLE`

### What was probed

Three minimal sessions per host, each a separate process with an isolated
`MEMESH_DIR`, driven by the host's own non-interactive mode. The numbers
below were read back from the transcript the host wrote, with
`node benchmarks/token/usage-probe.mjs <transcript> --arm <label>`.

| Arm | What it isolates | Prompt |
|---|---|---|
| control | host baseline, no MCP server | "Reply with exactly the word OK" |
| tool-schema | memesh MCP server attached, no tool called | same, "do not call any tool" |
| tool-result | one `recall` call and its result in context | "call recall once, then reply OK" |

### Claude Code (`claude -p --output-format json`, model `claude-haiku-4-5-20251001`, 2026-09-10)

| Arm | requests | input | cache_read | cache_creation | **context_tokens** | output | tool calls |
|---|---|---|---|---|---|---|---|
| control | 1 | 10 | 0 | 20 763 | **20 773** | 43 | 0 |
| tool-schema | 1 | 10 | 17 622 | 3 262 | **20 894** | 46 | 0 |
| tool-result | 3 | 30 | 59 944 | 3 976 | **63 950** | 295 | 2 (`ToolSearch`, `recall`) |

Per request in the tool-result arm: 20 903 → 21 439 → 21 608 context tokens.
The jump between request 1 and 2 (+536) is the `ToolSearch` result that
loaded `recall`'s schema; between 2 and 3 (+169) is the recall result.

Source of truth: `~/.claude/projects/<cwd-key>/<session>.jsonl`, one
`assistant` record per content block; records that share a `requestId`
carry the same `message.usage`. Fields: `input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`,
`message.model`. The `--output-format json` result carries the same totals
plus `modelUsage.<model>.costUSD`.

### Codex (`codex exec --sandbox read-only`, model `gpt-5.6-luna`, 2026-09-10)

| Arm | requests | input (incl. cached) | cached | cache_write | **context_tokens** | output |
|---|---|---|---|---|---|---|
| control | 1 | 29 650 | 9 984 | 0 | **29 650** | 5 |

Source of truth: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
`event_msg` records of type `token_count` with `info.last_token_usage`
(`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
`output_tokens`, `reasoning_output_tokens`); the model is in
`turn_context.payload.model`. Tool calls are `response_item` records of type
`function_call`. Only the control arm was run on Codex; the field inventory
is what the verdict needs, and a 6 479-request existing rollout parsed with
the same probe (877 tool calls attributed) shows the shape holds at scale.

### Findings that shape the contract

1. **Usage is authoritative and per request on both hosts.** Every number
   above is a field the host recorded from the model API response. No
   estimation was needed at any point.
2. **The session boundary is the transcript file**, and one file belongs to
   one arm, so arm attribution is exact.
3. **Tool definitions are not itemised** by either host. Their cost is
   visible only as the difference between arms — which is what a paired
   design measures anyway. In Claude Code, MCP tool schemas are *deferred*:
   attaching the server cost +121 context tokens, and the schema itself was
   paid for when `ToolSearch` loaded it (+536). A benchmark that assumed
   "attach server = pay schema" would attribute the cost to the wrong turn.
4. **Prompt caching crosses sessions.** The tool-schema arm read 17 622
   tokens from a cache the control arm had just written. `input_tokens`
   alone therefore says almost nothing; the comparable quantity is
   `context_tokens` = input + cache_read + cache_creation (Claude Code) or
   `input_tokens` (Codex, which already includes cached tokens). Cache tiers
   change the price, not what the model read.
5. **Thinking/reasoning tokens are inside `output_tokens`** on both hosts
   (`output_tokens_details.thinking_tokens`, `reasoning_output_tokens`).
6. **Diagnostics stay diagnostics.** Character counts, serialized bytes and
   tokenizer estimates are not accepted anywhere in a result; `validate.mjs`
   rejects a manifest that carries them.

## Part 2 — Frozen benchmark contract

Machine-readable in `contract.json`; the cases in `cases.json`;
`validate.mjs` enforces both. This section explains the rules, it does not
duplicate the values.

### Cases

Eight required categories, each covered by at least one case:
session-start-helpful, explicit-recall, no-relevant-memory,
stale-or-unsupported-answer, degraded-search, window-or-output-truncation,
conflict, post-compact-exact-lookup.

Every case defines **one** `ground_truth` block. Both arms seed it
identically; per-arm ground truth is a validation failure. Every case states
the expected answer (`must_contain`, optional `must_not_contain`), whether
abstaining is the correct outcome, and the failure class when it goes wrong.
At least one case is marked `negative`: a plausible but superseded answer is
present in the corpus and accepting it fails as `stale-answer-accepted`.

The corpus is synthetic. `validate.mjs` scans every case field a runner puts
in front of a model (memories, prompt, expected answer) and fails on anything
shaped like a key or a real user path; no owner secret, private transcript or
real owner graph may be seeded. Matching for `must_contain` /
`must_not_contain` is case-insensitive substring, and a negative case's stale
phrase must be present in its own corpus or the validator rejects it.

### Arms

`control` is the packaged memesh with today's default recall output;
`treatment` is the packaged memesh with the candidate projection. Same tools,
same prompts, same time limits, same host and model. The benchmark runs the
**shipped** product — no benchmark-side search, ranking or serializer
(the lesson of the LongMemEval harness, see `../longmemeval/METHODOLOGY.md`).

### Scoring

Nine dimensions, each reported on its own and never folded into one number:
task success, unsupported-or-stale error, abstention, input tokens, output
tokens, context tokens, tool calls, fallbacks, latency. Failure classes are
the closed list in `contract.json`.

### Provenance a result must carry

A run manifest is refused unless it names the `source_sha` (40 hex), the
`artifact_digest` of the packed product, the `corpus_digest` (SHA-256 of the
cases array — the validator recomputes it), the `host` and `model`, and one
usage-probe ledger per arm under `usage_provenance`, each with its
`transcript_sha256`. A ledger whose host or model disagrees with the manifest
is refused.

### Pilot → freeze

`contract.statistics.status` starts as `pilot`. A pilot run estimates the
variance of the paired difference; then `sample_size`, `repeats_per_case` and
`minimum_meaningful_effect` are set **once** and the status becomes `frozen`.
`validate.mjs --official` refuses a run while the status is `pilot`, and the
thresholds are not changed after an official result has been seen. The
analysis is paired (treatment − control per case) with a 95% confidence
interval.

### What this file does not do

It does not run the benchmark (#252 builds the A/B runner), does not define
the compact projection (#253), and makes no claim about token savings. Every
public conclusion drawn later is bound to a workload, model, host, version,
source SHA and artifact digest; no general percentage is ever stated.

## Replaying the verdict

```bash
# 1. Produce a transcript with the host's non-interactive mode (isolated MEMESH_DIR)
printf 'Reply with exactly the word OK and nothing else.' \
  | claude -p --model claude-haiku-4-5-20251001 --output-format json \
      --setting-sources "" --strict-mcp-config --mcp-config empty.json > control.json
# 2. Read its usage back from the transcript the host wrote
node benchmarks/token/usage-probe.mjs ~/.claude/projects/<cwd-key>/<session_id>.jsonl --arm control
# 3. Check the contract and (later) a run manifest
node benchmarks/token/validate.mjs
node benchmarks/token/validate.mjs --run results/<run>.json --official
```

A run manifest holds ledgers (numbers and digests). Never copy the raw
transcript into `results/`: it carries prompt text, and nothing under
`benchmarks/token/` is ignored by git.

`--mcp-config` takes several paths, so the prompt goes on stdin; a prompt
given as a trailing argument is read as another config file.
