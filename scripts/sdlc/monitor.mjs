// Stage 6: deterministic detection, no model. Reads the public origin and the
// CI history, compares each metric with `bands` in sdlc/config.json, and
// prints the highest tier reached. The workflow turns tier >= diagnose into a
// Claude run and files an intent; this script never calls a model.
//
// Missing data is a breach of its own, never "fine": an origin that answers
// without a release sha is reported as `public_ready_sha_missing`.
//
//   node scripts/sdlc/monitor.mjs --json
//   node scripts/sdlc/monitor.mjs --ci-runs runs.json   (offline: pass host output)

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./lib.mjs";
import { arg, isMain } from "./cli.mjs";

export const TIERS = ["ok", "log", "diagnose", "propose"];
const FETCH_TIMEOUT_MS = 15000;

function tierFor(value, band) {
  let tier = "ok";
  for (const step of band.tiers) {
    const crossed = band.direction === "above" ? value >= step.threshold : value <= step.threshold;
    if (crossed) tier = step.tier;
  }
  return tier;
}

export function ciFailureRate(runs) {
  const done = runs.filter((run) => run.conclusion && run.conclusion !== "cancelled" && run.conclusion !== "skipped");
  if (done.length === 0) return { value: 0, sample: 0 };
  const failed = done.filter((run) => run.conclusion !== "success").length;
  return { value: failed / done.length, sample: done.length };
}

export async function readyProbe(origin, { readyPath = "/api/ready", shaField = "releaseSha" } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(`${origin}${readyPath}`, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const ms = Date.now() - started;
    let body = null;
    try { body = await response.json(); } catch { /* not json */ }
    const sha = typeof body?.[shaField] === "string" ? body[shaField] : null;
    return { status: response.status, ms, sha };
  } catch (error) {
    return { status: null, ms: Date.now() - started, sha: null, error: error.message };
  }
}

function hostRuns(config, limit) {
  const repo = process.env.GITHUB_REPOSITORY ?? process.env.CI_PROJECT_PATH ?? config.repo;
  const branch = config.defaultBranch ?? "main";
  if ((config.host ?? "github") === "gitlab") {
    const out = execFileSync("glab", ["api", `projects/${encodeURIComponent(repo)}/pipelines?ref=${branch}&per_page=${limit}`], { encoding: "utf8" });
    return JSON.parse(out).map((p) => ({ conclusion: p.status === "success" ? "success" : p.status === "failed" ? "failure" : p.status }));
  }
  const out = execFileSync("gh", ["api", `repos/${repo}/actions/runs?branch=${branch}&event=push&per_page=${limit}`], { encoding: "utf8" });
  return JSON.parse(out).workflow_runs ?? [];
}

export function evaluate({ bands, ready, runs, mainSha }) {
  const metrics = [];
  const push = (metric, value, detail, band) => metrics.push({ metric, value, detail, tier: band ? tierFor(value, band) : "ok" });

  // No public origin (a library, a CLI, an npm package): the three public
  // metrics are recorded as not evaluated at the log tier, so every run shows
  // the gap in its summary, and nothing here reads as "up".
  if (ready === null) {
    for (const name of ["public_ready_down", "public_ready_latency_ms", "public_ready_sha_missing"]) {
      metrics.push({ metric: name, value: null, detail: "not evaluated: no public origin configured (sdlc/config.json origin is null)", tier: "log" });
    }
  } else {
    const down = ready.status !== 200 ? 1 : 0;
    push("public_ready_down", down, `GET ready -> ${ready.status ?? ready.error} in ${ready.ms}ms`, bands.public_ready_down);
    push("public_ready_latency_ms", ready.ms, `${ready.ms}ms`, bands.public_ready_latency_ms);

    const shaMissing = ready.status === 200 && !/^[0-9a-f]{40}$/u.test(ready.sha ?? "") ? 1 : 0;
    push("public_ready_sha_missing", shaMissing, shaMissing ? `ready answered 200 but reported no 40-hex release sha (${ready.sha})` : "release sha present", bands.public_ready_sha_missing ?? { direction: "above", tiers: [{ tier: "diagnose", threshold: 1 }] });
  }

  const failure = ciFailureRate(runs);
  const enough = failure.sample >= (bands.ci_failure_rate_main.minSample ?? 1);
  push("ci_failure_rate_main", failure.value, `${(failure.value * 100).toFixed(0)}% of the last ${failure.sample} runs on the default branch failed${enough ? "" : " (below minimum sample; not banded)"}`, enough ? bands.ci_failure_rate_main : null);

  if (mainSha && ready?.sha) {
    const drift = mainSha !== ready.sha ? 1 : 0;
    push("release_drift", drift, drift ? `default branch ${mainSha.slice(0, 12)} is not deployed (running ${ready.sha.slice(0, 12)})` : "deployment matches the default branch", bands.release_drift);
  } else {
    push("release_drift", 0, `not evaluated: ${!mainSha ? "no default-branch sha in this environment" : ready === null ? "no public origin configured" : "no release sha from the origin"}`, null);
  }

  const worst = metrics.reduce((acc, m) => (TIERS.indexOf(m.tier) > TIERS.indexOf(acc) ? m.tier : acc), "ok");
  return { checkedAt: new Date().toISOString(), tier: worst, metrics, breaches: metrics.filter((m) => m.tier !== "ok") };
}

if (isMain(import.meta.url)) {
  const config = loadConfig();
  const origin = config.origin ? config.origin.replace(/\/$/u, "") : null;
  const ciRunsFile = arg("ci-runs");
  const runs = ciRunsFile ? JSON.parse(readFileSync(ciRunsFile, "utf8")) : hostRuns(config, config.bands.ci_failure_rate_main.window ?? 20);
  const mainSha = process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA ?? null;
  const ready = origin ? await readyProbe(origin, config.smoke ?? {}) : null;
  const result = evaluate({ bands: config.bands, ready, runs, mainSha });
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else for (const m of result.metrics) console.log(`${m.tier.padEnd(8)} ${m.metric}: ${m.detail}`);
  process.exitCode = 0;
}
