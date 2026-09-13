import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { STAGES, changedPaths, checkArtifact, promptVars, renderPrompt, requestBody, stageInvocation } from "./run-stage.mjs";
import { REPO_ROOT, loadConfig } from "./lib.mjs";

test("every stage's prompt file exists and its placeholders are ones the runner fills", () => {
  for (const [name, stage] of Object.entries(STAGES)) {
    const file = path.join(REPO_ROOT, stage.prompt);
    assert.ok(existsSync(file), `${name}: ${stage.prompt}`);
    const placeholders = [...readFileSync(file, "utf8").matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((m) => m[1]);
    for (const p of placeholders) assert.ok(["SLUG", "ARTIFACT", "METRIC", "BREACH", "PROJECT", "CONSTRAINTS", "VERIFY", "RUN", "CELL"].includes(p), `${name}: {{${p}}}`);
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

test("spec, plan and diagnose stages get no shell beyond read-only git/host listing; only build may run the package manager and push, and no stage may merge", () => {
  for (const name of ["spec", "plan", "diagnose"]) {
    const tools = STAGES[name].tools.join(",");
    assert.equal(STAGES[name].access, "artifact");
    assert.ok(!/Bash\(pnpm|Bash\(npm|Bash\(git push|Bash\(gh pr create|Bash\(glab mr create/u.test(tools), `${name}: ${tools}`);
    assert.ok(!tools.split(",").includes("Bash"), `${name} must not get unrestricted Bash`);
  }
  assert.equal(STAGES.build.access, "build");
  const build = stageInvocation({}, "build", "p");
  const allowed = build.args[build.args.indexOf("--allowedTools") + 1];
  assert.match(allowed, /Bash\(pnpm \*\)/u);
  assert.match(allowed, /Bash\(gh pr create:\*\)/u);
  assert.ok(!/gh pr \*|gh pr merge|glab mr \*|glab mr merge/u.test(allowed), `build must not be able to merge: ${allowed}`);
  assert.equal(build.args[build.args.indexOf("--output-format") + 1], "json");
  const codex = stageInvocation({ agent: { provider: "codex" } }, "spec", "p", { runDir: tmpdir() });
  assert.equal(codex.command, "codex");
  assert.ok(codex.args.includes("workspace-write"));
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

test("a stage's model follows sdlc/config.json: the claude default per stage, or the provider's own default, or the configured name", () => {
  delete process.env.SDLC_MODEL;
  assert.equal(stageInvocation({}, "plan", "p").model, "claude-opus-5");
  assert.equal(stageInvocation({ agent: { provider: "codex" } }, "plan", "p", { runDir: tmpdir() }).model, null);
  assert.equal(stageInvocation({ agent: { models: { plan: "deepseek-v4-flash" }, baseUrl: "http://dgx90:4000" } }, "plan", "p").env.ANTHROPIC_BASE_URL, "http://dgx90:4000");
});

test("a stage's request body carries one Coverage row per artifact with the three verdict cells filled", async (t) => {
  const body = requestBody({ stage: "spec", outFile: "docs/specs/x.md", artifact: "intent/x.md", resultFile: "spec-x.json", model: "codex:default" });
  const row = body.split("\n").find((line) => line.startsWith("| `docs/specs/x.md` |"));
  assert.ok(row, "a Coverage row for the artifact");
  assert.equal(row.split("|").length - 2, 4, "Surface, QA, Review, Simplification");
  assert.match(row, /codex:default/u);
  const checkerPath = path.join(REPO_ROOT, "scripts", "verify-change-coverage.mjs");
  if (!existsSync(checkerPath)) { t.diagnostic("no scripts/verify-change-coverage.mjs in this repository; the machine check of the row is not exercised here"); return; }
  const { checkCoverage } = await import(checkerPath);
  assert.deepEqual(checkCoverage({ changed: ["docs/specs/x.md"], body }), { ok: true, problems: [] });
});

test("build and review are different models by default", async () => {
  assert.notEqual(STAGES.build.model, "claude-opus-5", "the review runs on claude-opus-5 by default; the implementer must differ");
});
