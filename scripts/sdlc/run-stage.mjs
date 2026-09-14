// Runs one stage of the loop headlessly: render the stage prompt, run
// `claude -p` with only the tools that stage needs, check the outcome with
// git (not with the model's words), and open the pull/merge request that the
// next human gate reviews.
//
//   node scripts/sdlc/run-stage.mjs --stage spec  --slug <slug> --artifact intent/<slug>.md
//   node scripts/sdlc/run-stage.mjs --stage plan  --slug <slug> --artifact docs/specs/<slug>.md
//   node scripts/sdlc/run-stage.mjs --stage build --slug <slug> --artifact docs/plans/<slug>.md
//   node scripts/sdlc/run-stage.mjs --stage diagnose --slug <slug> --metric <name> --breach breach.json
//   add --dry-run to print the rendered prompt and the claude arguments only.
//
// Outcome checks are deterministic: the expected file exists with the expected
// frontmatter, nothing else changed, the default branch did not move, the
// request exists. The run record goes to .sdlc-run/ (gitignored).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, git, loadConfig, parseFrontmatter } from "./lib.mjs";
import { arg, isMain } from "./cli.mjs";
import { hostFor } from "./host.mjs";
import { invocationFor, providerOf } from "./agent.mjs";

export const STAGES = {
  spec: {
    prompt: ".claude/sdlc/prompts/spec.md",
    output: (slug) => `docs/specs/${slug}.md`,
    branch: (slug) => `sdlc/spec/${slug}`,
    access: "artifact",
    tools: ["Read", "Grep", "Glob", "Write", "Edit"],
    model: "claude-sonnet-5",
    maxTurns: 60,
    title: (slug) => `spec: ${slug}`,
    label: "sdlc:spec",
    statuses: ["draft"],
  },
  plan: {
    prompt: ".claude/sdlc/prompts/plan.md",
    output: (slug) => `docs/plans/${slug}.md`,
    branch: (slug) => `sdlc/plan/${slug}`,
    access: "artifact",
    tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash(git log *)", "Bash(git diff *)"],
    model: "claude-opus-5",
    maxTurns: 120,
    title: (slug) => `plan: ${slug}`,
    label: "sdlc:plan",
    statuses: ["draft", "blocked"],
  },
  build: {
    prompt: ".claude/sdlc/prompts/build.md",
    output: null,
    branch: (slug) => `sdlc/${slug}`,
    access: "build",
    // No `gh pr merge` / `glab mr merge`: opening the request is the stage's
    // last act; accepting it is a person's. With a provider that cannot take
    // an allowlist (codex, gemini) the same rule is enforced after the run:
    // a merged request fails the stage (see below) and branch protection
    // decides what the loop's token may do at all (bootstrap step 3).
    tools: ["Read", "Grep", "Glob", "Write", "Edit", "MultiEdit", "Bash(pnpm *)", "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(git *)", "Bash(gh pr create:*)", "Bash(gh pr view:*)", "Bash(gh pr comment:*)", "Bash(gh pr checks:*)", "Bash(glab mr create:*)", "Bash(glab mr view:*)"],
    // Sonnet implements; the review runs on claude-opus-5 (or the provider's
    // review model), a different model from the implementer, as REVIEW.md
    // requires.
    model: "claude-sonnet-5",
    maxTurns: 400,
    title: (slug) => `feat: ${slug}`,
    label: "sdlc:build",
    statuses: [],
  },
  diagnose: {
    prompt: ".claude/sdlc/prompts/diagnose.md",
    output: (slug) => `intent/${slug}.md`,
    branch: (slug) => `sdlc/intent/${slug}`,
    access: "artifact",
    tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash(git log *)", "Bash(gh run *)", "Bash(gh pr list *)", "Bash(glab ci *)", "Bash(glab mr list *)"],
    model: "claude-sonnet-5",
    maxTurns: 60,
    title: (slug) => `intent (monitor): ${slug}`,
    label: "sdlc:intent",
    statuses: ["draft"],
  },
};

// Values every stage prompt may reference; all from sdlc/config.json.
export function promptVars(config) {
  const constraints = (config.constraints ?? []).map((line) => `- ${line}`).join("\n") || "- README.md";
  return {
    PROJECT: config.project ?? config.repo ?? "this",
    CONSTRAINTS: constraints,
    VERIFY: config.commands?.verify ?? "pnpm verify",
    RUN: config.commands?.run ?? "(no run command configured)",
  };
}

// The model call itself is built by scripts/sdlc/agent.mjs from
// sdlc/config.json → agent (provider claude | codex | gemini, per-stage
// models, optional endpoint). Nothing here knows a provider's flags.
export function stageInvocation(config, stage, prompt, { runDir = path.join(REPO_ROOT, ".sdlc-run"), name = stage } = {}) {
  const spec = STAGES[stage];
  return invocationFor(config, { stage, access: spec.access, prompt, tools: spec.tools, maxTurns: spec.maxTurns, claudeDefault: spec.model, runDir, name });
}

export function renderPrompt(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/gu, (match, key) => (key in vars ? String(vars[key]) : match));
}

function sh(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], env });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))));
  });
}

// Paths git would commit or that are untracked and not ignored. `.sdlc-run/`
// and `.verify/` are gitignored, so run records never count as changes.
export function changedPaths(root = REPO_ROOT) {
  return git(["status", "--porcelain", "--untracked-files=all"], { cwd: root })
    .split("\n").filter(Boolean).map((line) => line.slice(3).trim());
}

// The request body for a spec, plan or diagnose stage. It carries the
// Coverage table REVIEW.md asks for (one row per changed file; QA, Review and
// Simplification verdicts), so a
// loop-generated request meets the same bar as a person's.
export function requestBody({ stage, outFile, artifact }) {
  const source = artifact || "the monitor breach report";
  return [
    `Proposes the \`${stage}\` artifact based on \`${source}\`.`,
    "",
    `Review \`${outFile}\`. To accept: set \`status: accepted\` in its frontmatter and merge. To request changes: leave it open for revision. Closing it makes the stage eligible again; inspect the retained branch before rerunning, because publication will not overwrite a conflicting branch.`,
    "",
    "Run diagnostics: CI job log. Raw model records stay on the runner and are not uploaded.",
    "",
    "## Coverage",
    "",
    "| Surface | QA | Review | Simplification |",
    "|---|---|---|---|",
    `| \`${outFile}\` | run-stage outcome check exit=0: allowed frontmatter status, no other file changed | UNVERIFIED: independent review and human acceptance pending | UNVERIFIED: brevity and unnecessary complexity await review |`,
  ].join("\n");
}

// Publish only through ordinary Git fast-forward rules. A conflicting remote
// branch is preserved for inspection rather than overwritten on a retry.
export function publishArtifact({ outFile, branch, title, artifact, base, root = REPO_ROOT }) {
  const options = { cwd: root };
  git(["add", "--", outFile], options);
  git(["-c", "user.name=sdlc-loop", "-c", "user.email=sdlc-loop@users.noreply.github.com", "commit", "-m", `${title}\n\nBased on ${artifact || "the monitor breach report"}.\nAccepting this artifact (status: accepted) on ${base} starts the next stage.`], options);
  git(["push", "-u", "origin", branch], options);
}

export function checkArtifact(file, allowedStatuses) {
  if (!existsSync(file)) return `expected ${file} to exist`;
  const { data } = parseFrontmatter(readFileSync(file, "utf8"));
  if (!allowedStatuses.includes(data.status)) return `${file} has status "${data.status}", expected one of ${allowedStatuses.join(", ")}`;
  return null;
}

export async function main() {
  const stage = arg("stage");
  const slug = arg("slug");
  const spec = STAGES[stage];
  if (!spec || !slug) throw new Error("usage: --stage <spec|plan|build|diagnose> --slug <slug> [--artifact <path>] [--dry-run]");
  const config = loadConfig();
  const host = hostFor(config);
  const base = config.defaultBranch ?? "main";
  const dryRun = process.argv.includes("--dry-run");
  const artifact = arg("artifact", "");
  const vars = { ...promptVars(config), SLUG: slug, ARTIFACT: artifact, METRIC: arg("metric", ""), BREACH: "" };
  const breachFile = arg("breach");
  if (breachFile) vars.BREACH = readFileSync(breachFile, "utf8").trim();
  const prompt = renderPrompt(readFileSync(path.join(REPO_ROOT, spec.prompt), "utf8"), vars);
  const runDir = path.join(REPO_ROOT, ".sdlc-run");
  const inv = stageInvocation(config, stage, prompt, { runDir, name: `${stage}-${slug}` });

  if (dryRun) {
    console.log(`# stage ${stage} slug ${slug} branch ${spec.branch(slug)} host ${host.name}\n# provider ${inv.label} (${providerOf(config).tested ? "tested" : "UNTESTED provider: first run records the result"})${config.agent?.baseUrl ? ` endpoint ${config.agent.baseUrl}` : ""}\n# ${inv.command} ${inv.args.map((a) => (a.length > 80 ? `"…${a.length} chars…"` : a)).join(" ")}\n\n${prompt}`);
    return;
  }

  // A stage rewrites the checkout (checkout -B, commits, pushes). It is meant
  // for a CI runner; on a person's machine it must be an explicit choice.
  if (!process.env.CI && !process.argv.includes("--allow-local")) {
    throw new Error("run-stage rewrites the working tree and pushes; run it in CI, or pass --allow-local from a disposable clone.");
  }
  const dirtyBefore = changedPaths();
  if (dirtyBefore.length > 0) throw new Error(`working tree not clean before stage: ${dirtyBefore.join(", ")}`);
  const baseBefore = git(["rev-parse", `origin/${base}`]);
  const branch = spec.branch(slug);
  git(["checkout", "-B", branch, `origin/${base}`]);

  mkdirSync(runDir, { recursive: true });
  const resultFile = path.join(runDir, `${stage}-${slug}.json`);
  let output = "";
  try {
    output = await sh(inv.command, inv.args, { env: inv.env });
  } finally {
    writeFileSync(resultFile, output || "{}");
  }
  const outcome = inv.result(output);
  console.log(`[sdlc] ${inv.label}: ${outcome.usage ? JSON.stringify(outcome.usage) : "no usage reported"}; ${outcome.text ? `${outcome.text.length} chars of final text` : "no final text"}`);

  git(["fetch", "--quiet", "origin", base]);
  if (git(["rev-parse", `origin/${base}`]) !== baseBefore) {
    throw new Error(`origin/${base} moved during the stage run; refusing to continue. Inspect the branch by hand.`);
  }

  if (stage === "build") {
    // Accepting is a person's act. A provider without a tool allowlist could
    // have merged its own request; that is a failed stage, recorded loudly,
    // and branch protection (bootstrap step 3) is what makes it impossible.
    if (host.requestState(branch, { root: REPO_ROOT }) === "merged") {
      throw new Error(`build stage merged its own request from ${branch}. Accepting is reserved for a person; tighten branch protection (scripts/sdlc/bootstrap.sh step 3) so the loop's token cannot merge.`);
    }
    const open = host.openRequests(branch, { cwd: REPO_ROOT });
    if (open.length === 0) {
      throw new Error(`build stage ended without an open ${host.name === "github" ? "pull" : "merge"} request from ${branch}. The run is recorded in ${path.relative(REPO_ROOT, resultFile)}; read it and the branch before retrying. The loop will retry this plan on its next run because no request exists yet.`);
    }
    console.log(`build request: ${open[0].url}`);
    return;
  }

  const outFile = spec.output(slug);
  const problem = checkArtifact(path.join(REPO_ROOT, outFile), spec.statuses);
  if (problem) throw new Error(`stage ${stage} failed its outcome check: ${problem}`);
  const extra = changedPaths().filter((file) => file !== outFile);
  if (extra.length > 0) throw new Error(`stage ${stage} changed files outside its artifact: ${extra.join(", ")}`);

  publishArtifact({ outFile, branch, title: spec.title(slug), artifact, base });
  const body = requestBody({ stage, outFile, artifact });
  console.log(host.createRequest({ branch, title: spec.title(slug), body, label: spec.label }, { cwd: REPO_ROOT }));
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sdlc] ${error.message}`);
    process.exitCode = 1;
  });
}
