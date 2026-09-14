import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RUNNER_SOURCE = fileURLToPath(new URL("./run-pending.mjs", import.meta.url));

test("the loop passes both Codex login methods to its CLI installation step", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/sdlc-loop.yml", import.meta.url), "utf8");
  const install = workflow.split(/^ {6}- /mu).find((step) => step.includes("run: node scripts/sdlc/agent.mjs --install"));
  assert.ok(install, "the provider installation step must exist");
  for (const key of ["OPENAI_API_KEY", "CODEX_AUTH_JSON"]) {
    assert.ok(install.includes(`${key}: \${{ secrets.${key} }}`), `${key} must reach installation, where Codex login is persisted`);
  }
});

test("loop and review workflows keep raw model records on the runner", () => {
  for (const name of ["sdlc-loop.yml", "sdlc-review.yml"]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(workflow, /actions\/upload-artifact@/u, `${name}: public uploads need a separate reviewed data contract`);
  }
});

function fixture(t, items) {
  const dir = mkdtempSync(path.join(tmpdir(), "sdlc-run-pending-"));
  const runner = path.join(dir, "run-pending.mjs");
  const itemsFile = path.join(dir, "pending.json");
  const routeLog = path.join(dir, "routes.jsonl");
  const sentinel = path.join(dir, "shell-ran");
  writeFileSync(runner, readFileSync(RUNNER_SOURCE));
  writeFileSync(itemsFile, typeof items === "string" ? items : JSON.stringify(typeof items === "function" ? items({ sentinel }) : items));
  writeFileSync(path.join(dir, "run-stage.mjs"), `
    import { appendFileSync } from "node:fs";
    const args = process.argv.slice(2);
    appendFileSync(process.env.SDLC_ROUTE_LOG, JSON.stringify(args) + "\\n");
    if (args[3] === process.env.SDLC_FAIL_SLUG) process.exit(Number(process.env.SDLC_FAIL_STATUS || 17));
  `);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    routeLog,
    sentinel,
    run({ failSlug = "", failStatus = "17" } = {}) {
      return spawnSync(process.execPath, [runner, itemsFile], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SDLC_ROUTE_LOG: routeLog,
          SDLC_FAIL_SLUG: failSlug,
          SDLC_FAIL_STATUS: failStatus,
        },
      });
    },
    routes() {
      return existsSync(routeLog) ? readFileSync(routeLog, "utf8").trim().split("\n").map(JSON.parse) : [];
    },
  };
}

const items = [
  { stage: "spec", slug: "alpha", artifact: "intent/alpha.md" },
  { stage: "plan", slug: "bravo", artifact: "docs/specs/bravo.md" },
  { stage: "build", slug: "charlie", artifact: "docs/plans/charlie.md" },
];

test("an empty pending list records a no-op and invokes no stages", (t) => {
  const run = fixture(t, []);
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no pending stages/u);
  assert.deepEqual(run.routes(), []);
});

test("all pending items route to run-stage sequentially with their original argv", (t) => {
  const run = fixture(t, items);
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(run.routes(), items.map(({ stage, slug, artifact }) => [
    "--stage", stage, "--slug", slug, "--artifact", artifact,
  ]));
});

test("the first failed stage stops later items and reports the failed item", (t) => {
  const run = fixture(t, items);
  const result = run.run({ failSlug: "bravo", failStatus: "17" });
  assert.equal(result.status, 17);
  assert.match(result.stderr, /plan bravo .*failed \(exit 17\); stopping pending stages/u);
  assert.deepEqual(run.routes().map((args) => args[3]), ["alpha", "bravo"]);
});

test("shell-like artifact text stays one argv value and is never interpreted", (t) => {
  const run = fixture(t, ({ sentinel }) => [{ stage: "spec", slug: "alpha", artifact: `intent/x; touch ${sentinel}; $(touch ${sentinel})` }]);
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(run.routes(), [[
    "--stage", "spec", "--slug", "alpha", "--artifact", `intent/x; touch ${run.sentinel}; $(touch ${run.sentinel})`,
  ]]);
  assert.equal(existsSync(run.sentinel), false);
});

test("malformed JSON or item data fails before any stage is invoked", (t) => {
  for (const invalid of ["{\"stage\":", [{ stage: "other", slug: "alpha", artifact: "intent/alpha.md" }]]) {
    const run = fixture(t, invalid);
    const result = run.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot read pending stages|pending stage at index 0 is malformed/u);
    assert.deepEqual(run.routes(), []);
  }
});
