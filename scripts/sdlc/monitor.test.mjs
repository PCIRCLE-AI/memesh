import assert from "node:assert/strict";
import test from "node:test";
import { ciFailureRate, evaluate } from "./monitor.mjs";
import { loadConfig } from "./lib.mjs";

const bands = loadConfig().bands;
const runs = (conclusions) => conclusions.map((conclusion) => ({ conclusion }));
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const metric = (result, name) => result.metrics.find((m) => m.metric === name);

test("config bands are well formed and every tier name is known", () => {
  for (const [name, band] of Object.entries(bands)) {
    for (const step of band.tiers) assert.ok(["log", "diagnose", "propose"].includes(step.tier), `${name}: ${step.tier}`);
  }
  assert.ok(bands.public_ready_sha_missing, "a missing sha has its own band");
});

test("everything inside the bands is ok", () => {
  const result = evaluate({ bands, ready: { status: 200, ms: 400, sha: SHA_A }, runs: runs(Array(10).fill("success")), mainSha: SHA_A });
  assert.equal(result.tier, "ok");
  assert.deepEqual(result.breaches, []);
});

test("a down public origin is the propose tier on its own", () => {
  const result = evaluate({ bands, ready: { status: null, ms: 30, error: "ECONNREFUSED" }, runs: [], mainSha: null });
  assert.equal(result.tier, "propose");
  assert.equal(result.breaches[0].metric, "public_ready_down");
});

test("an origin that answers without a release sha is a breach, not a match", () => {
  const result = evaluate({ bands, ready: { status: 200, ms: 300, sha: null }, runs: runs(["success"]), mainSha: SHA_A });
  assert.equal(metric(result, "public_ready_sha_missing").tier, "diagnose");
  assert.equal(metric(result, "release_drift").tier, "ok");
  assert.match(metric(result, "release_drift").detail, /not evaluated/u);
});

test("a project without a public origin records the public metrics as not evaluated at the log tier, never as ok", () => {
  const result = evaluate({ bands, ready: null, runs: runs(Array(10).fill("success")), mainSha: SHA_A });
  for (const name of ["public_ready_down", "public_ready_latency_ms", "public_ready_sha_missing"]) {
    assert.equal(metric(result, name).tier, "log", name);
    assert.match(metric(result, name).detail, /not evaluated: no public origin/u, name);
  }
  assert.match(metric(result, "release_drift").detail, /no public origin/u);
  assert.equal(metric(result, "ci_failure_rate_main").tier, "ok");
  assert.equal(result.tier, "log");
});

test("CI failure rate needs a minimum sample and climbs through the tiers", () => {
  assert.deepEqual(ciFailureRate(runs(["success", "failure", "cancelled"])), { value: 0.5, sample: 2 });
  const small = evaluate({ bands, ready: { status: 200, ms: 300, sha: SHA_A }, runs: runs(["failure", "failure"]), mainSha: null });
  assert.equal(metric(small, "ci_failure_rate_main").tier, "ok", "two runs are not a trend");
  assert.match(metric(small, "ci_failure_rate_main").detail, /below minimum sample/u);
  const bad = evaluate({ bands, ready: { status: 200, ms: 300, sha: SHA_A }, runs: runs(["failure", "failure", "failure", "success", "success"]), mainSha: null });
  assert.equal(metric(bad, "ci_failure_rate_main").tier, "propose");
});

test("latency and release drift only log until they get worse", () => {
  const result = evaluate({ bands, ready: { status: 200, ms: 2000, sha: SHA_B }, runs: runs(["success"]), mainSha: SHA_A });
  assert.equal(result.tier, "log");
  assert.deepEqual(result.breaches.map((b) => b.metric).sort(), ["public_ready_latency_ms", "release_drift"]);
});
