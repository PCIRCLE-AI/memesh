// Which CLI runs the model stages (spec, plan, build, diagnose, review and the
// model-backed evals), and how it is invoked. Nothing else in the loop knows a
// provider's flags: run-stage, review and evals ask this module for the
// command to spawn and for the text and tool calls a run produced.
//
// sdlc/config.json → agent:
//   provider      "claude" (default) | "codex" | "gemini"
//   models        { spec, plan, build, diagnose, review, evals }: model names
//                 that provider expects; omitted → the provider's own default
//                 (claude: the per-stage defaults in run-stage.mjs)
//   baseUrl       an OpenAI- or Anthropic-compatible server (a LiteLLM proxy,
//                 the DGX vLLM). claude: ANTHROPIC_BASE_URL. codex: a custom
//                 model_provider entry (chat completions). gemini: not supported.
//   authTokenEnv  name of the env var holding that server's token
//
// Credentials in CI, one of each provider's list below, as repository secrets
// or CI variables. Locally the CLI's own login is enough.
//
//   node scripts/sdlc/agent.mjs --check     exit 1 with ::error when no credential env is set
//   node scripts/sdlc/agent.mjs --install   install the pinned CLI and log in from the env
//   node scripts/sdlc/agent.mjs --print     the resolved provider, CLI and models
//
// Tested: claude (signalscope-ai, memesh) and codex (memesh, 2026-09-14).
// gemini is wired from its documentation only; the first project to use it
// records the result in docs/sdlc/LOOP.md.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "./lib.mjs";
import { isMain } from "./cli.mjs";

export const PROVIDERS = {
  claude: {
    cli: "claude",
    install: ["npm", "install", "-g", "@anthropic-ai/claude-code@2.1.270"],
    credentials: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    credentialHelp: "CLAUDE_CODE_OAUTH_TOKEN (Pro/Max subscription; `claude setup-token` prints it) or ANTHROPIC_API_KEY (API billing)",
    tested: true,
  },
  codex: {
    cli: "codex",
    install: ["npm", "install", "-g", "@openai/codex@0.154.0"],
    credentials: ["OPENAI_API_KEY", "CODEX_AUTH_JSON"],
    credentialHelp: "OPENAI_API_KEY (API billing) or CODEX_AUTH_JSON (the contents of ~/.codex/auth.json after `codex login`; ChatGPT subscription; treat it as a password and re-paste it when a run reports it expired)",
    tested: true,
  },
  gemini: {
    cli: "gemini",
    install: ["npm", "install", "-g", "@google/gemini-cli@0.59.0"],
    credentials: ["GEMINI_API_KEY"],
    credentialHelp: "GEMINI_API_KEY (Google AI Studio)",
    tested: false,
  },
};

// What a run may do. `artifact`: write files, no shell (spec, plan, diagnose).
// `read`: nothing but reading (review, evals). `build`: shell, git, network
// (the build stage; the CI runner is the sandbox).
export const ACCESS = ["artifact", "read", "build"];

export function providerOf(config) {
  const name = config.agent?.provider ?? "claude";
  if (!PROVIDERS[name]) throw new Error(`sdlc/config.json agent.provider "${name}" is not one of ${Object.keys(PROVIDERS).join(", ")}`);
  return { name, ...PROVIDERS[name] };
}

export function modelFor(config, stage, claudeDefault = null) {
  const agent = config.agent ?? {};
  const provider = providerOf(config).name;
  return process.env.SDLC_MODEL ?? agent.models?.[stage] ?? agent.model ?? (provider === "claude" ? claudeDefault : null);
}

export function credentialPresent(config, env = process.env) {
  const provider = providerOf(config);
  const found = provider.credentials.filter((name) => Boolean(env[name]));
  return { provider: provider.name, present: found.length > 0, found, expected: provider.credentials, help: provider.credentialHelp };
}

const CLAUDE_READ_TOOLS = ["Read", "Grep", "Glob", "Bash(git log *)", "Bash(git diff *)"];

// The command to spawn for one run. `tools` is the Claude allowlist (the other
// CLIs express the same thing as a sandbox level from `access`).
export function invocationFor(config, { stage, access, prompt, tools = CLAUDE_READ_TOOLS, maxTurns = 60, claudeDefault = null, runDir = ".sdlc-run", name = stage, stream = false, env = process.env }) {
  if (!ACCESS.includes(access)) throw new Error(`access must be one of ${ACCESS.join(", ")}`);
  const provider = providerOf(config);
  const model = modelFor(config, stage, claudeDefault);
  const agent = config.agent ?? {};
  const label = `${provider.name}:${model ?? "default"}`;

  if (provider.name === "claude") {
    const runEnv = { ...env };
    if (agent.baseUrl) runEnv.ANTHROPIC_BASE_URL = agent.baseUrl;
    if (agent.authTokenEnv && env[agent.authTokenEnv]) runEnv.ANTHROPIC_AUTH_TOKEN = env[agent.authTokenEnv];
    const args = ["-p", prompt, "--output-format", stream ? "stream-json" : "json", ...(stream ? ["--verbose"] : []), ...(model ? ["--model", model] : []), "--max-turns", String(maxTurns), "--allowedTools", tools.join(",")];
    return {
      provider: provider.name, model, label, command: "claude", args, env: runEnv,
      result: (stdout) => {
        if (stream) {
          const events = parseJsonLines(stdout);
          const last = events.filter((e) => e?.type === "result").pop();
          return { text: typeof last?.result === "string" ? last.result : "", usage: last?.usage ?? null, transcript: stdout };
        }
        let parsed = null;
        try { parsed = JSON.parse(stdout); } catch { /* not json: reported below */ }
        return { text: typeof parsed?.result === "string" ? parsed.result : "", usage: parsed?.usage ?? null, transcript: stdout };
      },
    };
  }

  if (provider.name === "codex") {
    mkdirSync(runDir, { recursive: true });
    const lastFile = path.join(runDir, `${name}.last-message.md`);
    const sandbox = access === "read" ? ["-s", "read-only"]
      : access === "artifact" ? ["-s", "workspace-write"]
      // The build stage pushes and opens a request, so it needs network and
      // git; a GitHub or GitLab runner is the sandbox. The default env policy
      // hides *TOKEN* variables from commands, which would blind `gh`.
      : ["--dangerously-bypass-approvals-and-sandbox", "-c", "shell_environment_policy.ignore_default_excludes=true"];
    const endpoint = agent.baseUrl
      ? ["-c", "model_provider=custom", "-c", "model_providers.custom.name=custom", "-c", `model_providers.custom.base_url=${agent.baseUrl}`, "-c", "model_providers.custom.wire_api=chat", ...(agent.authTokenEnv ? ["-c", `model_providers.custom.env_key=${agent.authTokenEnv}`] : [])]
      : [];
    const args = ["exec", "--ephemeral", "--color", "never", "--json", "--ignore-user-config", "-o", lastFile, ...(model ? ["-m", model] : []), ...endpoint, ...sandbox, prompt];
    return {
      provider: provider.name, model, label, command: "codex", args, env: { ...env },
      result: (stdout) => {
        const events = parseJsonLines(stdout);
        const usage = events.filter((e) => e?.type === "turn.completed").pop()?.usage ?? null;
        const text = existsSync(lastFile) ? readFileSync(lastFile, "utf8").trim() : "";
        return { text, usage, transcript: stdout };
      },
    };
  }

  // gemini: documented flags; not exercised here (PROVIDERS.gemini.tested).
  const approval = access === "read" ? "plan" : access === "artifact" ? "auto_edit" : "yolo";
  const args = ["-p", prompt, "--output-format", "json", ...(model ? ["-m", model] : []), "--approval-mode", approval];
  return {
    provider: provider.name, model, label, command: "gemini", args, env: { ...env },
    result: (stdout) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* not json: reported below */ }
      return { text: typeof parsed?.response === "string" ? parsed.response : "", usage: parsed?.stats ?? null, transcript: stdout };
    },
  };
}

export function parseJsonLines(text) {
  const events = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* a non-JSON line (progress, warnings) */ }
  }
  return events;
}

// Tool calls a run made, in one shape for every provider: { name, text }.
// claude: the tool_use blocks of a stream-json transcript. codex: the
// command_execution and file_change items of a --json transcript. gemini's
// JSON output carries no tool trace, so it yields none (evals say so).
export function toolCalls(provider, transcript) {
  const calls = [];
  const events = parseJsonLines(transcript);
  if (provider === "claude") {
    for (const event of events) {
      const blocks = event?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== "tool_use") continue;
        const input = block.input ?? {};
        calls.push({ name: block.name, text: String(input.command ?? input.file_path ?? input.path ?? input.pattern ?? "") });
      }
    }
  } else if (provider === "codex") {
    for (const event of events) {
      if (event?.type !== "item.completed") continue;
      const item = event.item ?? {};
      if (item.type === "command_execution") calls.push({ name: "Bash", text: String(item.command ?? "") });
      if (item.type === "file_change") for (const change of item.changes ?? []) calls.push({ name: "Write", text: String(change.path ?? "") });
      if (item.type === "mcp_tool_call") calls.push({ name: String(item.tool ?? "mcp"), text: JSON.stringify(item.arguments ?? {}) });
    }
  }
  return calls;
}

export function finalText(provider, transcript) {
  const events = parseJsonLines(transcript);
  if (provider === "claude") return events.filter((e) => e?.type === "result").map((e) => e.result).filter((t) => typeof t === "string").pop() ?? "";
  if (provider === "codex") return events.filter((e) => e?.type === "item.completed" && e.item?.type === "agent_message").map((e) => e.item.text).filter((t) => typeof t === "string").pop() ?? "";
  let parsed = null;
  try { parsed = JSON.parse(transcript); } catch { /* handled below */ }
  return typeof parsed?.response === "string" ? parsed.response : "";
}

function runSync(command, args, { input } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"], input });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

// Install the pinned CLI and, where the provider needs a login step, log in
// from the environment. Every action is printed; nothing is skipped quietly.
export function install(config, env = process.env, log = console.log) {
  const provider = providerOf(config);
  log(`agent: installing ${provider.install.join(" ")}`);
  runSync(provider.install[0], provider.install.slice(1));
  if (provider.name === "codex") {
    const home = env.CODEX_HOME || path.join(homedir(), ".codex");
    if (env.OPENAI_API_KEY) {
      log("agent: codex login --with-api-key (OPENAI_API_KEY from the environment)");
      runSync("codex", ["login", "--with-api-key"], { input: env.OPENAI_API_KEY });
    } else if (env.CODEX_AUTH_JSON) {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "auth.json"), env.CODEX_AUTH_JSON, { mode: 0o600 });
      log(`agent: wrote ${path.join(home, "auth.json")} from CODEX_AUTH_JSON (subscription login)`);
    } else {
      log("agent: codex installed; no OPENAI_API_KEY or CODEX_AUTH_JSON in the environment, so no login was performed");
    }
  } else {
    log(`agent: ${provider.cli} reads its credential from the environment (${provider.credentialHelp}); no login step`);
  }
}

if (isMain(import.meta.url)) {
  const config = loadConfig();
  const provider = providerOf(config);
  if (process.argv.includes("--print")) {
    console.log(JSON.stringify({ provider: provider.name, cli: provider.cli, tested: provider.tested, install: provider.install.join(" "), credentials: provider.credentials, models: config.agent?.models ?? {}, baseUrl: config.agent?.baseUrl ?? null }, null, 2));
  } else if (process.argv.includes("--check")) {
    const status = credentialPresent(config);
    if (status.present) {
      console.log(`agent: provider ${status.provider}, credential present (${status.found.join(", ")})`);
    } else {
      console.log(`::error::No model credential for provider ${status.provider}: set ${status.help}. Run scripts/sdlc/bootstrap.sh.`);
      process.exitCode = 1;
    }
  } else if (process.argv.includes("--install")) {
    install(config);
  } else {
    console.error("usage: node scripts/sdlc/agent.mjs --check | --install | --print");
    process.exitCode = 2;
  }
}
