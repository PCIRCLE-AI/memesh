# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **the architecture-decision directory**, once one exists: read the decisions that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

Neither exists yet in this repo, which is the expected starting state.

## File structure

Treat this as a single-context repo: one product, one domain vocabulary, which
is why a single glossary fits. The layout underneath that is not uniform, and an
agent enumerating source files will miss code if it assumes it is. There is no
npm workspace — the root `package.json` has no `workspaces` field — and the four
places a `package.json`-or-`src/` sweep will find each look different:

| Where | Shape |
|---|---|
| repository root | `package.json`; code in `src/`, and also in `scripts/`, `tests/` and `benchmarks/` — `"lint": "eslint src/ scripts/ tests/ dashboard/src/"` in `package.json` is the authority on which of those is first-class |
| `dashboard/` | its own `package.json`, sources in `dashboard/src/`, built into `dashboard/dist/` |
| `extensions/memory-memesh/` | its own `package.json`, TypeScript at the directory root (`index.ts`, `config.ts`) — **no `src/`** |
| `extensions/hermes-memesh/` | Python: `__init__.py` and `plugin.yaml`, **no `package.json` at all** |

So "three `package.json` files and two `src/` trees" is the whole of what a
`package.json` or `src/` sweep will find, and it is not the whole of the code.

The glossary is `CONTEXT.md` at the repository root, named throughout this
document. Architecture decisions go in a directory beside it; that directory has
no agreed path yet, so this document deliberately does not name one — the agent
writing the first decision picks the conventional location and records it here
in the same change.

(The skills also support a multi-context layout, keyed on a `CONTEXT-MAP.md` at
the root. This repo does not use it; reach for it only if the three packages
ever grow separate domain vocabularies.)

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts the decision to keep `entities_fts` contentless, but worth reopening because…_

## Note on this repo's existing documents

A glossary written here holds the **domain vocabulary** and nothing the
architecture, API and contribution documents already answer. `CLAUDE.md` opens
by explaining why.
