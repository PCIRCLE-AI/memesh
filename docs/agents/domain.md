# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

Neither exists yet in this repo, which is the expected starting state.

## File structure

This is a single-context repo: one package, one `src/`, no workspaces.

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── src/
```

(The skills also support a multi-context layout, keyed on a `CONTEXT-MAP.md` at
the root. This repo does not use it; add one only if it ever splits into
packages with their own `src/`.)

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## Note on this repo's existing documents

`CLAUDE.md` is deliberately a pointer, not a copy: the architecture, the API
surface and the contribution rules live in `docs/ARCHITECTURE.md`,
`docs/api/API_REFERENCE.md` and `CONTRIBUTING.md`, and duplicating them is how
they drift. A `CONTEXT.md` written here should hold the **domain vocabulary**
and nothing those documents already answer.
