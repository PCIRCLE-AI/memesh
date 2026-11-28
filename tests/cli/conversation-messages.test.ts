import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationMessages } from "../../src/core/conversation-messages.js";
import { buildIsolatedRuntimeEnv } from "../../scripts/lib/isolated-env.mjs";

const roots: string[] = [];
const stores: ConversationMessages[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memesh-cli-conversation-"));
  roots.push(root);
  const store = new ConversationMessages({ file: path.join(root, "messages.db"), machine: os.hostname() });
  stores.push(store);
  store.register({ id: "sender", host: "codex", machine: os.hostname(), pid: process.pid, wake: { thread: "sender" } });
  store.register({ id: "receiver", host: "claude-code", machine: os.hostname(), pid: process.pid, wake: { socket: "/tmp/receiver" } });
  return { root, store };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const loader = `
  import { pathToFileURL } from "node:url";
  const { createServer } = await import(pathToFileURL(process.argv[1] + "/node_modules/vite/dist/node/index.js").href);
  const server = await createServer({ root: process.argv[1], appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try { const { runCli } = await server.ssrLoadModule("/src/transports/cli/cli.ts"); await runCli([process.argv[0], "memesh", ...process.argv.slice(2)]); }
  finally { await server.close(); }
`;
function run(root: string, session: string | undefined, args: string[], input?: string) {
  const env = buildIsolatedRuntimeEnv(process.env, { runtimeHome: root, memeshDir: root, dbPath: path.join(root, 'knowledge-graph.db') });
  return spawnSync(process.execPath, ["--input-type=module", "--eval", loader, path.resolve("."), ...args], {
    cwd: path.resolve("."), encoding: "utf8", input,
    env: { ...env, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: session ?? '', MEMESH_AUTO_CAPTURE: 'false' },
  });
}

describe("CLI conversation messages", () => {
  it("keeps the public surface to four actions and does not open the knowledge graph", () => {
    const { root } = fixture(); const help = run(root, undefined, ["message", "--help"]);
    expect(help.status).toBe(0); for (const action of ["discover", "send", "read", "status"]) expect(help.stdout).toContain(action);
    expect(help.stdout).not.toContain("intake"); expect(fs.existsSync(path.join(root, "knowledge-graph.db"))).toBe(false);
  });
  it("sends stdin as the host conversation and exposes owner audit status", () => {
    const { root, store } = fixture(); store.close(); stores.pop();
    const sent = run(root, "sender", ["message", "send", "--recipient", "receiver", "--kind", "question", "--payload-stdin"], "START\nMID\nEND");
    expect(sent.status).toBe(0); const message = JSON.parse(sent.stdout); expect(message.state).toBe("queued");
    const read = run(root, "receiver", ["message", "read", "--message-id", message.message_id]);
    expect(read.status).toBe(0); expect(JSON.parse(read.stdout).message.body).toBe("START\nMID\nEND");
    const status = run(root, undefined, ["message", "status", "--json"]);
    expect(status.status).toBe(0); const rows = JSON.parse(status.stdout).messages;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: message.message_id, state: "read" });
    expect(rows[0].events.map((event: { event: string }) => event.event)).toEqual(["queued", "delivered", "read"]);
  });
  it("passes oversized stdin to core so its rejection remains auditable", () => {
    const { root, store } = fixture(); store.close(); stores.pop();
    const result = run(root, "sender", ["message", "send", "--recipient", "receiver", "--kind", "task", "--payload-stdin"], "x".repeat(9_000));
    expect(result.status).toBe(1); expect(result.stderr).toContain("message_too_large");
    const status = run(root, undefined, ["message", "status", "--json"]);
    expect(status.status).toBe(0); expect(JSON.parse(status.stdout).messages[0]).toMatchObject({ body: null, body_bytes: 9_000, state: "rejected" });
  });
  it("requires stdin and rejects payload argv without printing or storing the value", () => {
    const { root, store } = fixture(); store.close(); stores.pop();
    const common = ["message", "send", "--recipient", "receiver", "--kind", "task"];
    const missing = run(root, "sender", common, "stdin body");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--payload-stdin");
    for (const option of ["--payload", "--body"]) {
      const result = run(root, "sender", [...common, "--payload-stdin", option, "private-argv-sentinel"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`unknown option '${option}'`);
      expect(result.stdout + result.stderr).not.toContain("private-argv-sentinel");
    }
    const audit = new ConversationMessages({ file: path.join(root, "messages.db"), machine: os.hostname() });
    try { expect(audit.status()).toEqual([]); } finally { audit.close(); }
  });
  it("rejects an unknown address and leaves the owner audit empty", () => {
    const { root, store } = fixture(); store.close(); stores.pop();
    const sent = run(root, "sender", ["message", "send", "--recipient", "missing", "--kind", "task", "--payload-stdin"], "do not save");
    expect(sent.status).toBe(1); expect(sent.stderr).toMatch(/unknown_recipient.*message discover/);
    const status = run(root, undefined, ["message", "status", "--json"]);
    expect(status.status).toBe(0);
    const rows = JSON.parse(status.stdout).messages;
    expect(rows).toEqual([]);
    if (process.platform !== "win32") expect(fs.statSync(path.join(root, "messages.db")).mode & 0o077).toBe(0);
  });
  it("refuses a send with no host identity before writing a message", () => {
    const { root, store } = fixture(); store.close(); stores.pop(); const result = run(root, undefined, ["message", "send", "--recipient", "receiver", "--kind", "task", "--payload-stdin"], "body");
    expect(result.status).toBe(1); expect(result.stderr).toContain("without a host session identity");
    const audit = new ConversationMessages({ file: path.join(root, "messages.db"), machine: os.hostname() });
    try { expect(audit.status()).toEqual([]); } finally { audit.close(); }
  });
});
