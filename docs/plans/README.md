# Plans

`docs/plans/<slug>.md` is the contract for one change: files, order, risks,
**Proof** (the machine-checkable definition of done) and the neighbouring flows
to re-walk. The loop generates it from an accepted spec; a person can also write
one by hand from `TEMPLATE.md` for work that does not come through an intent.
The file name is the slug, the same one the intent, the spec and the build
branch `sdlc/<slug>` use, so the state machine can pair them.
Merging with `status: accepted` starts the build stage. The commit gate refuses
a commit of 20 or more source lines on a branch with no plan. When the code
departs from the plan, the plan changes in the same commit.
