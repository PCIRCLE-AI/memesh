You are producing the requirements-and-design spec for one accepted intent in the {{PROJECT}} repository. You are running headless in CI; nobody will answer questions. Where the intent leaves something open, write it under "Open questions" instead of guessing.

Intent: read `{{ARTIFACT}}` in full.

Constraints you must apply, in this order of authority (read each one; quote it when you flag a concern):
{{CONSTRAINTS}}

Write `docs/specs/{{SLUG}}.md` using `docs/specs/TEMPLATE.md` exactly: keep its frontmatter keys, set `status: draft`, `intent: {{ARTIFACT}}`. Do not add author or generator attribution. Sections: Problem (restated from the intent in the product's vocabulary), Requirements (numbered, each testable), Design (which existing modules, routes, components and stores change; no parallel implementation, no new runtime), Data and rights, Security and privacy, Out of scope, Concerns (every place the intent conflicts with a constraint above, or two constraints conflict with each other; the product owner resolves these before engineering sees the spec), Open questions (carried forward from the intent plus new ones), Acceptance (what a reviewer checks to accept this spec).

Rules: do not change any file other than `docs/specs/{{SLUG}}.md`. Do not write code. Do not invent capabilities the constraints exclude. Keep the spec under 250 lines.
