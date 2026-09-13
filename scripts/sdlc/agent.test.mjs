import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PROVIDERS, credentialPresent, finalText, invocationFor, modelFor, providerOf, toolCalls } from "./agent.mjs";

const base = { agent: {} };

test("provider defaults to claude; an unknown provider is refused by name", () => {
  assert.equal(providerOf({}).name, "claude");
  assert.equal(providerOf({ agent: { provider: "codex" } }).cli, "codex");
  assert.throws(() => providerOf({ agent: { provider: "bard" } }), /not one of claude, codex, gemini/u);
  assert.equal(PROVIDERS.gemini.tested, false, "gemini stays marked untested until a project runs it");
});

test("model resolution: SDLC_MODEL, then agent.models.<stage>, then agent.model, then the claude default only for claude", () => {
  delete process.env.SDLC_MODEL;
  assert.equal(modelFor({}, "spec", "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(modelFor({ agent: { provider: "codex" } }, "spec", "claude-sonnet-5"), null, "codex uses its own default, never a claude model name");
  assert.equal(modelFor({ agent: { provider: "codex", models: { spec: "gpt-5.6-sol" } } }, "spec"), "gpt-5.6-sol");
  assert.equal(modelFor({ agent: { model: "x" } }, "build"), "x");
  process.env.SDLC_MODEL = "override";
  assert.equal(modelFor({ agent: { models: { spec: "y" } } }, "spec"), "override");
  delete process.env.SDLC_MODEL;
});

test("credential check names what it looked for and never reads a credential as present from an empty value", () => {
  const none = credentialPresent({ agent: { provider: "codex" } }, {});
  assert.deepEqual([none.present, none.expected], [false, ["OPENAI_API_KEY", "CODEX_AUTH_JSON"]]);
  assert.match(none.help, /OPENAI_API_KEY/u);
  assert.equal(credentialPresent({ agent: { provider: "codex" } }, { OPENAI_API_KEY: "" }).present, false);
  assert.deepEqual(credentialPresent({}, { ANTHROPIC_API_KEY: "k" }).found, ["ANTHROPIC_API_KEY"]);
});

test("claude invocation: allowlist, max turns, json output; a baseUrl becomes ANTHROPIC_BASE_URL and the token env is passed through", () => {
  const inv = invocationFor(base, { stage: "spec", access: "artifact", prompt: "P", tools: ["Read", "Write"], maxTurns: 7, claudeDefault: "claude-sonnet-5", env: { PATH: "/bin", T: "tok" } });
  assert.equal(inv.command, "claude");
  assert.deepEqual(inv.args, ["-p", "P", "--output-format", "json", "--model", "claude-sonnet-5", "--max-turns", "7", "--allowedTools", "Read,Write"]);
  assert.equal(inv.env.ANTHROPIC_BASE_URL, undefined);
  const custom = invocationFor({ agent: { baseUrl: "http://dgx90:4000", authTokenEnv: "T", models: { spec: "deepseek-v4-flash" } } }, { stage: "spec", access: "artifact", prompt: "P", env: { PATH: "/bin", T: "tok" } });
  assert.equal(custom.env.ANTHROPIC_BASE_URL, "http://dgx90:4000");
  assert.equal(custom.env.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(custom.model, "deepseek-v4-flash");
  const stream = invocationFor(base, { stage: "evals", access: "read", prompt: "P", stream: true, env: {} });
  assert.ok(stream.args.includes("stream-json") && stream.args.includes("--verbose"));
  assert.equal(inv.result(JSON.stringify({ result: "done", usage: { input_tokens: 1 } })).text, "done");
  assert.equal(stream.result('{"type":"assistant"}\n{"type":"result","result":"final"}\n').text, "final");
});

test("codex invocation: sandbox level follows access, stdin is never read, the last message file carries the answer", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdlc-agent-"));
  try {
    const cfg = { agent: { provider: "codex" } };
    const read = invocationFor(cfg, { stage: "review", access: "read", prompt: "P", runDir: dir, env: {} });
    assert.equal(read.command, "codex");
    assert.equal(read.args[0], "exec");
    assert.ok(read.args.includes("--ephemeral") && read.args.includes("--json") && read.args.includes("--ignore-user-config"));
    assert.deepEqual(read.args.slice(read.args.indexOf("-s"), read.args.indexOf("-s") + 2), ["-s", "read-only"]);
    assert.equal(read.args.at(-1), "P", "the prompt is the last argument, never read from stdin");
    assert.ok(!read.args.includes("-m"), "no -m when no model is configured: the CLI's default");
    const artifact = invocationFor(cfg, { stage: "spec", access: "artifact", prompt: "P", runDir: dir, env: {} });
    assert.deepEqual(artifact.args.slice(artifact.args.indexOf("-s"), artifact.args.indexOf("-s") + 2), ["-s", "workspace-write"]);
    const build = invocationFor(cfg, { stage: "build", access: "build", prompt: "P", runDir: dir, env: {} });
    assert.ok(build.args.includes("--dangerously-bypass-approvals-and-sandbox"), "the CI runner is the sandbox for the build stage");
    assert.ok(build.args.includes("shell_environment_policy.ignore_default_excludes=true"), "gh must see its token");
    const endpoint = invocationFor({ agent: { provider: "codex", baseUrl: "http://dgx90:8000/v1", authTokenEnv: "DGX_KEY", models: { spec: "deepseek" } } }, { stage: "spec", access: "artifact", prompt: "P", runDir: dir, env: {} });
    assert.ok(endpoint.args.includes("model_providers.custom.base_url=http://dgx90:8000/v1"));
    assert.ok(endpoint.args.includes("model_providers.custom.env_key=DGX_KEY"));
    assert.deepEqual(endpoint.args.slice(endpoint.args.indexOf("-m"), endpoint.args.indexOf("-m") + 2), ["-m", "deepseek"]);
    const out = '{"type":"turn.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}\n';
    const result = read.result(out);
    assert.equal(result.text, "", "no last-message file written: no text, not a made-up one");
    assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gemini invocation follows the documented flags and is labelled untested", () => {
  const inv = invocationFor({ agent: { provider: "gemini", models: { build: "gemini-2.5-pro" } } }, { stage: "build", access: "build", prompt: "P", env: {} });
  assert.equal(inv.command, "gemini");
  assert.deepEqual(inv.args, ["-p", "P", "--output-format", "json", "-m", "gemini-2.5-pro", "--approval-mode", "yolo"]);
  assert.equal(invocationFor({ agent: { provider: "gemini" } }, { stage: "review", access: "read", prompt: "P", env: {} }).args.at(-1), "plan");
  assert.equal(inv.result(JSON.stringify({ response: "R", stats: {} })).text, "R");
});

test("tool calls are normalized per provider; gemini has no trace and says so by yielding none", () => {
  const claude = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"node scripts/verify-receipt.mjs"}},{"type":"tool_use","name":"Read","input":{"file_path":"docs/plans/README.md"}}]}}\n{"type":"result","result":"docs/plans with a Proof section"}\n';
  assert.deepEqual(toolCalls("claude", claude), [{ name: "Bash", text: "node scripts/verify-receipt.mjs" }, { name: "Read", text: "docs/plans/README.md" }]);
  assert.equal(finalText("claude", claude), "docs/plans with a Proof section");
  const codex = '{"type":"item.completed","item":{"type":"command_execution","command":"cat .verify/receipt.json","exit_code":0}}\n{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"docs/specs/x.md","kind":"add"}]}}\n{"type":"item.completed","item":{"type":"agent_message","text":"see docs/plans"}}\n';
  assert.deepEqual(toolCalls("codex", codex), [{ name: "Bash", text: "cat .verify/receipt.json" }, { name: "Write", text: "docs/specs/x.md" }]);
  assert.equal(finalText("codex", codex), "see docs/plans");
  assert.deepEqual(toolCalls("gemini", JSON.stringify({ response: "x" })), []);
  assert.equal(finalText("gemini", JSON.stringify({ response: "x" })), "x");
});

test("access must be one of the three levels", () => {
  assert.throws(() => invocationFor(base, { stage: "spec", access: "root", prompt: "P", env: {} }), /access must be one of/u);
});
