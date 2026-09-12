# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **the architecture-decision directory**, once one exists: read the decisions that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

Neither exists yet in this repo, which is the expected starting state.

## File structure

Treat this as a single-context repo, with one caveat worth knowing: there is no
npm workspace (the root `package.json` has no `workspaces` field), but there are
three `package.json` files and two `src/` trees — the root package, `dashboard/`
(its own package and `src/`, built into `dashboard/dist/`), and
`extensions/memory-memesh/`. They are one product with one domain vocabulary,
which is why a single glossary fits; a reviewer enumerating source files must
still remember that `dashboard/src/` exists.

A glossary belongs at the repository root, and architecture decisions in a
directory beside it. Neither is created yet, so this document does not name
their paths — an agent writing the first one picks the conventional location and
adds it here at the same time.

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
