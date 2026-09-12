# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies. Child of another issue: add `--parent <number-or-url>`. Blocked by others: add `--blocked-by <n>,<n>`. Both flags need gh ≥ 2.94 and both are present in the version this repo is developed against (2.100.0); `gh --version` if in doubt.
- **Labels must exist before they are applied**: `gh label list --json name --jq '.[].name'`; create a missing one with `gh label create <name> --color <hex> --description "..."`. `gh issue edit --add-label` fails on a label that does not exist.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

It is `no` because every pull request so far has come from the maintainer, none from a fork — so a PR here is work already accepted, not a request awaiting judgement. Flip the flag when that changes.

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,comments`, then keep only PRs from outside the maintainers (`isCrossRepository: true` identifies fork PRs).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: create it as a sub-issue of the map in one step: `gh issue create --parent <map-number> --label wayfinder:<type> ...`. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. At creation time use `gh issue create --blocked-by <n>,<n>` (blockers are always created first, so their numbers exist). To add an edge afterwards: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). A ticket is unblocked when every blocker is closed.
- **Frontier query**: `gh issue list` has no parent filter, so list open issues asking for the parent and filter locally: `gh issue list --state open --json number,title,parent,assignees --jq '[.[] | select(.parent.number == <map>) | select(.assignees | length == 0)]'`, then drop any whose `issue_dependencies_summary.blocked_by` is above zero (`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`); first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer to the map's Decisions-so-far.

The `wayfinder:*` labels are not created yet; create them the first time a map is opened.
