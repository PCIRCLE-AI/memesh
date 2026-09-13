import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { STAGES, agentEnv, changedPaths, checkArtifact, claudeArgs, promptVars, renderPrompt, requestBody } from "./run-stage.mjs";
import { REPO_ROOT, loadConfig } from "./lib.mjs";

test("every stage's prompt file exists and its placeholders are ones the runner fills", () => {
  for (const [name, stage] of Object.entries(STAGES)) {
    const file = path.join(REPO_ROOT, stage.prompt);
    assert.ok(existsSync(file), `${name}: ${stage.prompt}`);
    const placeholders = [...readFileSync(file, "utf8").matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((m) => m[1]);
    for (const p of placeholders) assert.ok(["SLUG", "ARTIFACT", "METRIC", "BREACH", "PROJECT", "CONSTRAINTS", "VERIFY", "RUN"].includes(p), `${name}: {{${p}}}`);
  }
});

test("prompt rendering substitutes known placeholders and leaves unknown ones visible", () => {
  assert.equal(renderPrompt("a {{SLUG}} b {{ARTIFACT}} c {{NOPE}}", { SLUG: "x", ARTIFACT: "intent/x.md" }), "a x b intent/x.md c {{NOPE}}");
});

test("prompt variables come from sdlc/config.json: project, constraints as a list, verify and run commands", () => {
  const config = loadConfig();
  const vars = promptVars(config);
  assert.equal(vars.PROJECT, config.project);
  assert.match(vars.CONSTRAINTS, /^- /u);
  assert.equal(vars.VERIFY, config.commands.verify);
  assert.deepEqual(promptVars({}), { PROJECT: "this", CONSTRAINTS: "- README.md", VERIFY: "pnpm verify", RUN: "(no run command configured)" });
});

test("spec, plan and diagnose stages get no shell beyond read-only git/host listing; only build may run pnpm and push", () => {
  for (const name of ["spec", "plan", "diagnose"]) {
    const tools = STAGES[name].tools.join(",");
    assert.ok(!/Bash\(pnpm|Bash\(npm|Bash\(git push|Bash\(gh pr create|Bash\(glab mr create/u.test(tools), `${name}: ${tools}`);
    assert.ok(!tools.split(",").includes("Bash"), `${name} must not get unrestricted Bash`);
  }
  const build = claudeArgs("build", "p");
  assert.match(build[build.indexOf("--allowedTools") + 1], /Bash\(pnpm \*\)/u);
  assert.equal(build[build.indexOf("--output-format") + 1], "json");
});

test("outcome check requires the artifact and an allowed status", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdlc-stage-"));
  try {
    const file = path.join(dir, "x.md");
    assert.match(checkArtifact(file, ["draft"]), /to exist/u);
    writeFileSync(file, "---\nstatus: accepted\n---\n");
    assert.match(checkArtifact(file, ["draft"]), /status "accepted"/u);
    writeFileSync(file, "---\nstatus: draft\n---\n");
    assert.equal(checkArtifact(file, ["draft"]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changed paths keep their leading dot and never include the gitignored run records", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdlc-changed-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    // The real repo's ignore rules for the two record directories.
    const ignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    assert.match(ignore, /^\.sdlc-run\/$/mu);
    assert.match(ignore, /^\.verify\/$/mu);
    writeFileSync(path.join(dir, ".gitignore"), ".sdlc-run/\n.verify/\n");
    mkdirSync(path.join(dir, ".github"));
    writeFileSync(path.join(dir, ".github", "x.yml"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    assert.deepEqual(changedPaths(dir), []);
    writeFileSync(path.join(dir, ".github", "x.yml"), "b\n");
    mkdirSync(path.join(dir, ".sdlc-run"));
    writeFileSync(path.join(dir, ".sdlc-run", "spec-x.json"), "{}");
    mkdirSync(path.join(dir, "docs", "specs"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "specs", "x.md"), "---\nstatus: draft\n---\n");
    assert.deepEqual(changedPaths(dir).sort(), [".github/x.yml", "docs/specs/x.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent endpoint: default is the claude CLI's own credentials; a configured baseUrl and per-stage model are passed through", () => {
  const plain = agentEnv({}, "spec");
  assert.equal(plain.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
  assert.equal(plain.model, null);
  process.env.SDLC_TEST_TOKEN = "t0k";
  const custom = agentEnv({ agent: { baseUrl: "http://dgx90:4000", authTokenEnv: "SDLC_TEST_TOKEN", models: { spec: "deepseek-v4-flash" } } }, "spec");
  assert.equal(custom.env.ANTHROPIC_BASE_URL, "http://dgx90:4000");
  assert.equal(custom.env.ANTHROPIC_AUTH_TOKEN, "t0k");
  assert.equal(custom.model, "deepseek-v4-flash");
  assert.equal(agentEnv({ agent: { baseUrl: "http://dgx90:4000", model: "deepseek-v4-flash" } }, "build").model, "deepseek-v4-flash");
  delete process.env.SDLC_TEST_TOKEN;
});

test("a stage's request body carries a Coverage row the change-coverage gate accepts", async () => {
  const body = requestBody({ stage: "spec", outFile: "docs/specs/x.md", artifact: "intent/x.md", resultFile: "spec-x.json", model: "claude-sonnet-5" });
  const checkerPath = path.join(REPO_ROOT, "scripts", "verify-change-coverage.mjs");
  if (!existsSync(checkerPath)) return; // repositories without the gate have nothing to satisfy
  const { checkCoverage } = await import(checkerPath);
  const result = checkCoverage({ changed: ["docs/specs/x.md"], body });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("build and review are different models", async () => {
  assert.notEqual(STAGES.build.model, "claude-opus-5", "the review workflow reviews with claude-opus-5; the implementer must differ");
});
