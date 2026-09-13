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

export const STAGES = {
  spec: {
    prompt: ".claude/sdlc/prompts/spec.md",
    output: (slug) => `docs/specs/${slug}.md`,
    branch: (slug) => `sdlc/spec/${slug}`,
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
    tools: ["Read", "Grep", "Glob", "Write", "Edit", "MultiEdit", "Bash(pnpm *)", "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(git *)", "Bash(gh pr *)", "Bash(glab mr *)"],
    // Sonnet implements; the review workflow's Opus is then a different model
    // from the implementer, as AGENTS.md requires.
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

// Where the model calls go. Default: Anthropic through the `claude` CLI's own
// credentials (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN). With
// `agent.baseUrl` in sdlc/config.json the CLI is pointed at any server that
// speaks the Anthropic Messages API (a LiteLLM/proxy in front of an
// OpenAI-compatible model such as the DGX90 DeepSeek vLLM), and
// `agent.models.<stage>` picks the model name that server expects.
export function agentEnv(config, stage) {
  const agent = config.agent ?? {};
  const env = { ...process.env };
  if (agent.baseUrl) env.ANTHROPIC_BASE_URL = agent.baseUrl;
  if (agent.authTokenEnv && process.env[agent.authTokenEnv]) env.ANTHROPIC_AUTH_TOKEN = process.env[agent.authTokenEnv];
  const model = agent.models?.[stage] ?? agent.model ?? null;
  return { env, model };
}

export function renderPrompt(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/gu, (match, key) => (key in vars ? String(vars[key]) : match));
}

export function claudeArgs(stage, prompt, { model = STAGES[stage].model } = {}) {
  const spec = STAGES[stage];
  return ["-p", prompt, "--output-format", "json", "--model", model, "--max-turns", String(spec.maxTurns), "--allowedTools", spec.tools.join(",")];
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
// Coverage table the repository's change-coverage gate requires (one row per
// changed file; QA, Review and Simplification verdicts; the Review cell names
// a model), so a loop-generated request is not refused by the loop's own CI.
export function requestBody({ stage, outFile, artifact, resultFile, model }) {
  const source = artifact || "the monitor breach report";
  return [
    `Generated by the SDLC loop (stage \`${stage}\`) from \`${source}\`.`,
    "",
    `Review \`${outFile}\`. To accept: set \`status: accepted\` in its frontmatter and merge. To send it back: edit and merge with \`status: draft\`, or close this request (a closed request makes the loop run the stage again).`,
    "",
    `Run record: workflow artifact \`${resultFile}\`.`,
    "",
    "## Coverage",
    "",
    "| Surface | QA | Review | Simplification |",
    "|---|---|---|---|",
    `| \`${outFile}\` | run-stage outcome check exit=0: frontmatter status accepted by checkArtifact, no other file changed | written by ${model}; the sdlc-review workflow (claude-opus-5) reviews this request; the person who merges it is the acceptance | not applicable: a generated Markdown artifact with no code; brevity is the reviewer's call |`,
  ].join("\n");
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
  const agent = agentEnv(config, stage);
  const args = claudeArgs(stage, prompt, { model: process.env.SDLC_MODEL ?? agent.model ?? spec.model });

  if (dryRun) {
    console.log(`# stage ${stage} slug ${slug} branch ${spec.branch(slug)} host ${host.name}\n# endpoint ${agent.env.ANTHROPIC_BASE_URL ?? "anthropic (claude CLI credentials)"}\n# claude ${args.map((a) => (a.length > 80 ? `"…${a.length} chars…"` : a)).join(" ")}\n\n${prompt}`);
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

  const runDir = path.join(REPO_ROOT, ".sdlc-run");
  mkdirSync(runDir, { recursive: true });
  const resultFile = path.join(runDir, `${stage}-${slug}.json`);
  let output = "";
  try {
    output = await sh("claude", args, { env: agent.env });
  } finally {
    writeFileSync(resultFile, output || "{}");
  }

  git(["fetch", "--quiet", "origin", base]);
  if (git(["rev-parse", `origin/${base}`]) !== baseBefore) {
    throw new Error(`origin/${base} moved during the stage run; refusing to continue. Inspect the branch by hand.`);
  }

  if (stage === "build") {
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

  git(["add", "--", outFile]);
  git(["-c", "user.name=sdlc-loop", "-c", "user.email=sdlc-loop@users.noreply.github.com", "commit", "-m", `${spec.title(slug)}\n\nGenerated by the SDLC loop from ${artifact || "the monitor"}.\nAccepting this artifact (status: accepted) on ${base} starts the next stage.`]);
  git(["push", "--force-with-lease", "-u", "origin", branch]);
  const body = requestBody({ stage, outFile, artifact, resultFile: path.basename(resultFile), model: process.env.SDLC_MODEL ?? agent.model ?? spec.model });
  console.log(host.createRequest({ branch, title: spec.title(slug), body, label: spec.label }, { cwd: REPO_ROOT }));
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sdlc] ${error.message}`);
    process.exitCode = 1;
  });
}
