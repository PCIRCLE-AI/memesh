import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pendingStages, SLUG_RE } from "./next-stage.mjs";

const none = () => "none";

function scaffold(files) {
  const root = mkdtempSync(path.join(tmpdir(), "sdlc-next-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    // A string is a status; { raw } is written verbatim.
    writeFileSync(path.join(root, file), typeof content === "string" ? `---\ntitle: T\nstatus: ${content}\n---\nbody\n` : content.raw);
  }
  return root;
}

const quiet = { error() {} };

test("an accepted intent without a spec is pending at the spec stage; drafts are not", () => {
  const root = scaffold({ "intent/alpha.md": "accepted", "intent/beta.md": "draft", "intent/README.md": "accepted" });
  try {
    assert.deepEqual(pendingStages({ root, requestState: none, logger: quiet }).map((p) => [p.stage, p.slug]), [["spec", "alpha"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each stage waits for its downstream artifact; the build waits for an open or merged request, retries after a closed one", () => {
  const root = scaffold({ "intent/alpha.md": "accepted", "docs/specs/alpha.md": "accepted", "docs/plans/alpha.md": "accepted" });
  try {
    assert.deepEqual(pendingStages({ root, requestState: none, logger: quiet }).map((p) => p.stage), ["build"]);
    assert.deepEqual(pendingStages({ root, requestState: () => "open", logger: quiet }), [], "an open build request is waited on");
    assert.deepEqual(pendingStages({ root, requestState: () => "merged", logger: quiet }), [], "a merged build request is done");
    const retried = pendingStages({ root, requestState: () => "closed", logger: quiet });
    assert.deepEqual(retried.map((p) => [p.stage, p.previous]), [["build", "closed"]], "a closed, unmerged request does not block a retry");
    writeFileSync(path.join(root, "docs/plans/alpha.md"), "---\nstatus: accepted\nbuild: pr\n---\n");
    assert.deepEqual(pendingStages({ root, requestState: () => { throw new Error("must not ask"); }, logger: quiet }), [], "a plan that records its build is not asked about again");
    writeFileSync(path.join(root, "docs/plans/alpha.md"), "---\nstatus: draft\n---\n");
    assert.deepEqual(pendingStages({ root, requestState: none, logger: quiet }), [], "a draft plan stops the chain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spec or plan stage with an open request from its own branch is not run twice", () => {
  const root = scaffold({ "intent/alpha.md": "accepted" });
  const errors = [];
  try {
    const state = (branch) => (branch === "sdlc/spec/alpha" ? "open" : "none");
    assert.deepEqual(pendingStages({ root, requestState: state, logger: { error: (m) => errors.push(m) } }), []);
    assert.ok(errors.some((m) => /already has an open request/u.test(m)));
    assert.deepEqual(pendingStages({ root, requestState: () => "closed", logger: quiet }).map((p) => p.stage), ["spec"], "a closed spec request is re-run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a host that cannot be asked stops the scan instead of guessing", () => {
  const root = scaffold({ "docs/plans/alpha.md": "accepted" });
  try {
    assert.throws(() => pendingStages({ root, requestState: () => { throw new Error("gh: not logged in"); }, logger: quiet }), /not logged in/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a slug that cannot be a branch name, or an artifact without a status, is reported and not advanced", () => {
  const root = scaffold({
    "intent/Bad Name.md": "accepted",
    "intent/$(rm -rf x).md": "accepted",
    "intent/ok-1.md": "accepted",
    "intent/no-front.md": { raw: "# just a heading\nstatus: accepted\n" },
    "intent/bom.md": { raw: "\uFEFF---\nstatus: accepted\n---\n" },
  });
  const errors = [];
  try {
    const pending = pendingStages({ root, requestState: none, logger: { error: (m) => errors.push(m) } });
    assert.deepEqual(pending.map((p) => p.slug), ["ok-1"]);
    assert.equal(errors.length, 4);
    assert.ok(errors.some((m) => /no-front\.md has no `status`/u.test(m)));
    assert.ok(errors.some((m) => /bom\.md has no `status`/u.test(m)));
    assert.ok(SLUG_RE.test("2026-09-13-monitor-ci-failure-rate-main"));
    assert.ok(!SLUG_RE.test("UPPER"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
