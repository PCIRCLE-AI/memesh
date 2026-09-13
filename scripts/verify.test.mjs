import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempRepo } from "./sdlc/lib.test.mjs";
import { lastRunPath, loadConfig, readJson, receiptPath, treeHash } from "./sdlc/lib.mjs";
import { verify, verifySteps } from "./verify.mjs";

const config = loadConfig();
const quiet = { log() {}, error() {} };
const ok = async () => ({ exit: 0, seconds: 0.1 });

test("verify steps come from sdlc/config.json in order; journeys-only keeps the steps marked journeys", () => {
  const ids = config.verify.steps.map((s) => s.id);
  assert.ok(ids.length >= 2, "a verify with fewer than two steps proves nothing about the running app");
  assert.deepEqual(verifySteps({ config }).map((s) => s.id), ids);
  assert.deepEqual(verifySteps({ config, journeysOnly: true }).map((s) => s.id), config.verify.steps.filter((s) => s.journeys).map((s) => s.id));
  assert.ok(config.verify.steps.some((s) => s.journeys), "at least one step must drive the built app");
  for (const step of verifySteps({ config })) assert.ok(path.isAbsolute(step.cwd));
});

test("green run writes a receipt bound to the tree; journeys-only never writes one", async () => {
  const repo = tempRepo();
  try {
    const result = await verify({ cwd: repo.dir, config, logger: quiet, execute: ok });
    assert.equal(result.ok, true);
    const receipt = readJson(receiptPath(repo.dir));
    assert.equal(receipt.tree, treeHash(repo.dir));
    assert.equal(receipt.outcome, "passed");
    assert.equal(receipt.steps.length, config.verify.steps.length);
    const only = await verify({ cwd: repo.dir, config, logger: quiet, execute: ok, journeysOnly: true });
    assert.equal(only.ok, true);
    assert.equal(readJson(lastRunPath(repo.dir)).mode, "journeys");
  } finally {
    repo.cleanup();
  }
});

test("a red step stops the run, records which step, and leaves no receipt", async () => {
  const repo = tempRepo();
  try {
    const seen = [];
    const redStep = config.verify.steps[1].id;
    const result = await verify({ cwd: repo.dir, config, logger: quiet, execute: async (step) => { seen.push(step.id); return { exit: step.id === redStep ? 1 : 0, seconds: 0 }; } });
    assert.equal(result.ok, false);
    assert.deepEqual(seen, config.verify.steps.slice(0, 2).map((s) => s.id));
    const last = readJson(lastRunPath(repo.dir));
    assert.equal(last.outcome, "failed");
    assert.equal(last.failedStep, redStep);
    assert.equal(readJson(receiptPath(repo.dir)), null);
  } finally {
    repo.cleanup();
  }
});

test("a crash inside the run is recorded as crashed, with no receipt", async () => {
  const repo = tempRepo();
  try {
    const result = await verify({ cwd: repo.dir, config, logger: quiet, execute: async () => { throw new Error("pnpm: command not found"); } });
    assert.equal(result.ok, false);
    const last = readJson(lastRunPath(repo.dir));
    assert.equal(last.outcome, "crashed");
    assert.match(last.error, /command not found/u);
    assert.equal(readJson(receiptPath(repo.dir)), null);
  } finally {
    repo.cleanup();
  }
});

test("a tree that changes while verify runs gets no receipt", async () => {
  const repo = tempRepo();
  try {
    const lastStep = config.verify.steps.at(-1).id;
    const result = await verify({ cwd: repo.dir, config, logger: quiet, execute: async (step) => { if (step.id === lastStep) writeFileSync(path.join(repo.dir, "a.txt"), "edited mid-run\n"); return { exit: 0, seconds: 0 }; } });
    assert.equal(result.ok, false);
    assert.equal(readJson(lastRunPath(repo.dir)).treeChangedDuringRun, true);
    assert.equal(readJson(receiptPath(repo.dir)), null);
  } finally {
    repo.cleanup();
  }
});
