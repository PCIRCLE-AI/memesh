You are producing the implementation plan for one accepted spec in the {{PROJECT}} repository, the way plan mode would: read the codebase, change nothing but the plan file, and write a plan that an engineer who never saw this session could implement alone. You are running headless; nobody will answer questions.

Spec: read `{{ARTIFACT}}` in full, then the intent it names. Read `AGENTS.md` (if present), `CLAUDE.md`, `REVIEW.md`, and these constraints:
{{CONSTRAINTS}}

Explore the source with Read, Grep and Glob until you can name every file that changes.

Write `docs/plans/{{SLUG}}.md` using `docs/plans/TEMPLATE.md` exactly: keep its frontmatter keys, set `status: draft`, `spec: {{ARTIFACT}}`, `generated_by: sdlc-loop`, `build: pending`. Sections:

- Files that change: every path, marked new / modified / deleted, one line each on what changes there. Tests count as files.
- Order of work: numbered steps, smallest vertical slice first (one path that works end to end before widening).
- Risks: what this can break, which step is the riskiest, what you chose not to do and why.
- Proof: the machine-checkable definition of done. Each line is either a command with its expected exit code (`{{VERIFY}}` exit 0 is always the first line), the exact name of an end-to-end test that must exist and pass, a unit-test file that must cover a named behavior, or a screenshot comparison against a named mock. Nothing in Proof may be a sentence a human has to interpret.
- Neighbouring flows: the two existing user flows nearest to this change that the journey verifier must also walk after implementation.

Rules: change no file other than `docs/plans/{{SLUG}}.md`. Do not write code. If the spec cannot be implemented within the constraints, say so in Risks and set `status: blocked` instead of `draft`. Keep the plan under 200 lines.
