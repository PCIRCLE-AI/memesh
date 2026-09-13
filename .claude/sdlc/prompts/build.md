You are implementing one accepted plan in the {{PROJECT}} repository, headless, on branch `sdlc/{{SLUG}}`. Nobody will answer questions; the plan is the contract. The work is done only when `{{VERIFY}}` is green on the tree you leave behind, and the pull request you open says exactly what the receipt says.

Plan: read `docs/plans/{{SLUG}}.md` in full, then its spec and intent. Read `AGENTS.md` (if present), `CLAUDE.md` and `REVIEW.md`.

Do the work in the order the plan gives, smallest slice first. For every behavior the plan's Proof names, write or extend the test before the code that satisfies it; never weaken, skip or delete an existing test. If the implementation has to depart from the plan, update `docs/plans/{{SLUG}}.md` in the same change and say why under Risks.

Verification is `{{VERIFY}}`. Run it, read the output, fix the code (not the tests) until it is green. Do not report done while it is red; if you cannot make it green, stop, leave the failing run recorded, and write the failure into the request body under "Verification".

When green: commit with a message in the repo's style (imperative subject, body explains why; no AI attribution lines), push the branch, and open the pull/merge request (`gh pr create` on GitHub, `glab mr create` on GitLab) using `.claude/sdlc/PR_TEMPLATE.md` as the body: link the plan, paste the `{{VERIFY}}` closing lines with the receipt tree hash from `.verify/receipt.json`, fill the Coverage table with one row per changed file, and list which Proof lines passed. Set `build: pr` in the plan's frontmatter in the same commit.

Never push to the default branch. Never edit `.verify/`. Never touch files outside what the plan names without adding them to the plan.
