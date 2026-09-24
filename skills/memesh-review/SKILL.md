---
name: memesh-review
description: Review and optimize the MeMesh memory database. Analyzes health score, finds stale or noisy memories, shows work patterns, and suggests human-reviewed cleanup actions. Use when asked to "review memories", "check memory health", "clean up knowledge", or "what's in my memory".
user-invocable: true
---

# MeMesh Memory Review

Review the memory database and provide actionable cleanup recommendations.

## How to Access

Use CLI (works everywhere) or MCP tools (if available). See the `memesh` skill for auto-detect instructions.

## Process

### Step 1: Gather data

```bash
# Get system health
memesh status

# Get all recent memories (structured output for analysis)
memesh recall --limit 50 --json

# `--tag` filters actual tags; inspect each returned entity's `type` to group decisions, lessons, and session records.
```

Recall is a bounded window, not a whole-database count. For an exact health
score and factor totals, use the Dashboard Analytics view after `memesh serve`
or its local `GET /v1/analytics` endpoint. If it is unavailable, omit the
score and label any counts from recall as sample counts.

If MCP `user_patterns` tool is available, also run it for work pattern analysis:
```json
user_patterns: {}
```

### Step 2: Analyze and report

Use the analytics result for graph-wide totals and health factors; use recalled
memories to illustrate findings. Present only fields you actually obtained:

```markdown
## Memory Health Report

### Overview
- Total entities: N
- Last 30 days active: N (N%)
- Knowledge types: N decisions, N patterns, N lessons, N auto-tracked

### Health Score: N/100
- Activity: N/30 points (active entities accessed in the last 30 days / all active entities)
- Quality: N/30 points (active entities with confidence > 0.7 / all active entities)
- Freshness: N/20 points (entities created in the last 7 days / all active entities, capped at 1)
- Lessons: N/20 points (`lesson_learned` entity count / 5, capped at 1)

### Quality Issues Found

**Stale (not accessed 30+ days, low confidence)**
- "entity-name" — confidence: N% — Suggest: archive?

**Verbose (5+ observations)**
- "entity-name" (N observations) — note it; there is no one-entity compression
  command. If useful knowledge is spread across episodic entries, an already
  running agent can prepare one MCP `work_package` for human review.

**Potential conflicts**
- "entity-A" vs "entity-B" — inspect the text and recommend an explicit
  `contradicts` or `supersedes` relation; MeMesh does not judge it automatically

**Noise ratio**
- N% auto-tracked (session_keypoint, commit) vs N% intentional knowledge
- If noise > 80%: recommend more deliberate `memesh remember` usage

### Recommended Actions
1. `memesh forget --name "old-design"` (superseded)
2. Ask the current agent to prepare one MCP `work_package`; then review the staged proposal
3. `memesh remember ...` (knowledge gap in [area])
```

### Step 3: Execute approved actions

Present the report first. Ask which actions to execute. Then run the commands:

```bash
memesh forget --name "outdated-entity"
# MCP work_package submits one proposal; then use dream show / accept / reject
memesh remember --name "missing-knowledge" --type decision --obs "..."
```

### Step 4: Verify

```bash
memesh recall --limit 5 --json    # confirm changes took effect
```

## Tips

- Run every 1-2 weeks to keep memory healthy
- Health score < 50 → inspect the four factor scores before recommending a cause
- Noise > 80% → encourage deliberate `memesh remember` for decisions
- Dashboard available at: http://localhost:3737/dashboard (run `memesh serve` first)
