// Post-deploy smoke journey against the configured public origin
// (`origin` and `smoke` in sdlc/config.json). Deterministic HTTP checks only:
// the deployment answers, runs the SHA it was authorized for, serves its
// pages, publishes OAuth discovery when configured, and challenges the MCP
// endpoint. Exit 1 on any miss.
//
// A project with no public origin (a package, a CLI) sets `smoke.command`
// instead: an argv array run from the repository root with {{SHA}} and
// {{VERSION}} substituted (VERSION is package.json's version at that sha,
// passed by the release workflow as --version). Its exit code is the only
// check; the last lines of its output are the detail. Exit 1 when neither an
// origin nor a command is configured: a receipt cannot come from nothing.
//
//   node scripts/sdlc/smoke-public.mjs --sha <40 hex> [--version <x.y.z>]
//   node scripts/sdlc/smoke-public.mjs --sha <40 hex> --json > smoke.json
//   node scripts/sdlc/smoke-public.mjs --render smoke.json    (print a saved result)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertPublicOrigin, loadConfig } from "./lib.mjs";
import { arg, isMain } from "./cli.mjs";

const FETCH_TIMEOUT_MS = 15000;

async function probe(url, init) {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...init });
    const text = await response.text();
    return { url, status: response.status, ms: Date.now() - started, headers: Object.fromEntries(response.headers), text };
  } catch (error) {
    return { url, status: null, ms: Date.now() - started, error: error.name === "TimeoutError" ? `timeout after ${FETCH_TIMEOUT_MS}ms` : error.message, text: "" };
  }
}

export function smokeCommand({ command, sha = null, version = null, cwd = process.cwd(), timeoutMs = 15 * 60 * 1000 } = {}) {
  const argv = command.map((part) => String(part).replaceAll("{{SHA}}", sha ?? "").replaceAll("{{VERSION}}", version ?? ""));
  const label = argv.join(" ");
  const run = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, SMOKE_SHA: sha ?? "", SMOKE_VERSION: version ?? "" } });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n");
  const tail = output.slice(-8).join(" | ");
  const ok = run.status === 0;
  const detail = run.error ? `could not run: ${run.error.message}` : `exit ${run.status ?? `signal ${run.signal}`}; ${tail || "(no output)"}`;
  return { origin: `command: ${label}`, sha, version, runningSha: null, checkedAt: new Date().toISOString(), ok, checks: [{ name: `${label} exits 0`, ok, detail }] };
}

export async function smoke({ origin, sha = null, version = null, smokeConfig = {}, cwd = process.cwd() } = {}) {
  if (!origin) {
    if (Array.isArray(smokeConfig.command) && smokeConfig.command.length > 0) return smokeCommand({ command: smokeConfig.command, sha, version, cwd });
    throw new Error("sdlc/config.json has origin: null and no smoke.command; nothing can be smoked, so no receipt can be written.");
  }
  const base = assertPublicOrigin(origin);
  const { readyPath = "/api/ready", shaField = "releaseSha", pages = [], oauthMetadata = false, mcpChallengePath = null } = smokeConfig;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  const ready = await probe(`${base}${readyPath}`);
  add(`${readyPath} answers 200`, ready.status === 200, `status ${ready.status ?? ready.error} in ${ready.ms}ms`);
  let readyBody = null;
  try { readyBody = JSON.parse(ready.text); } catch { /* not json */ }
  const runningSha = typeof readyBody?.[shaField] === "string" ? readyBody[shaField] : null;
  add(`${readyPath} reports a 40-hex release sha in ${shaField}`, /^[0-9a-f]{40}$/u.test(runningSha ?? ""), String(runningSha));
  if (sha) add("running sha is the authorized sha", runningSha === sha, `running ${runningSha}, authorized ${sha}`);

  for (const page of pages) {
    const res = await probe(`${base}${page}`);
    add(`${page} renders`, res.status === 200 && /<html/iu.test(res.text), `status ${res.status ?? res.error}`);
  }

  if (oauthMetadata) {
    const as = await probe(`${base}/.well-known/oauth-authorization-server`);
    let asBody = null;
    try { asBody = JSON.parse(as.text); } catch { /* not json */ }
    add("oauth authorization-server metadata", as.status === 200 && Array.isArray(asBody?.scopes_supported) && asBody.scopes_supported.length > 0, `status ${as.status ?? as.error}, scopes ${asBody?.scopes_supported?.length ?? "n/a"}`);
    if (mcpChallengePath) {
      const pr = await probe(`${base}/.well-known/oauth-protected-resource${mcpChallengePath}`);
      add(`oauth protected-resource metadata for ${mcpChallengePath}`, pr.status === 200, `status ${pr.status ?? pr.error}`);
    }
  }

  if (mcpChallengePath) {
    const mcp = await probe(`${base}${mcpChallengePath}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    add(`${mcpChallengePath} challenges unauthenticated calls with 401`, mcp.status === 401 && /bearer/iu.test(mcp.headers?.["www-authenticate"] ?? ""), `status ${mcp.status ?? mcp.error}, www-authenticate ${mcp.headers?.["www-authenticate"] ?? "absent"}`);
  }

  return { origin: base, sha, runningSha, checkedAt: new Date().toISOString(), ok: checks.every((check) => check.ok), checks };
}

export function render(result) {
  const lines = result.checks.map((check) => `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
  const running = result.runningSha ?? (result.version ? `version ${result.version}` : `sha ${result.sha ?? "unknown"}`);
  lines.push(result.ok ? `smoke GREEN for ${result.origin} (${running}) at ${result.checkedAt}` : `smoke RED for ${result.origin} at ${result.checkedAt}`);
  return lines.join("\n");
}

if (isMain(import.meta.url)) {
  const renderFile = arg("render", null);
  const result = renderFile
    ? JSON.parse(readFileSync(renderFile, "utf8"))
    : await (async () => { const config = loadConfig(); return smoke({ origin: config.origin, sha: arg("sha", null), version: arg("version", null), smokeConfig: config.smoke ?? {} }); })();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(render(result));
  process.exitCode = result.ok ? 0 : 1;
}
