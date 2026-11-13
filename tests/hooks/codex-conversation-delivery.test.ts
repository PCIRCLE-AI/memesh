import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { journeyEnv } from '../../src/core/doctor-journey.js';

it('Codex declared hooks deliver complete bidirectional messages through per-call MCP identities', async () => {
  const runtime = path.resolve('.');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-message-wire-'));
  const env = journeyEnv(home);
  env.CODEX_PLUGIN_ROOT = runtime;
  env.PLUGIN_ROOT = runtime;
  env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(runtime, 'scripts/lib/account-home-preload.mjs')).href}`;
  const offline = path.join(home, 'offline.mjs');
  fs.writeFileSync(offline, `import net from 'node:net'; import { syncBuiltinESMExports } from 'node:module';
    net.Socket.prototype.connect = () => { throw new Error('Synthetic hook fixture forbids network'); };
    globalThis.fetch = async () => { throw new Error('Synthetic hook fixture forbids fetch'); };
    syncBuiltinESMExports();`);
  env.NODE_OPTIONS += ` --import=${pathToFileURL(offline).href}`;
  expect(env.MEMESH_HOOK_HOST).toBeUndefined();
  fs.mkdirSync(env.MEMESH_DIR!, { mode: 0o700 });
  fs.writeFileSync(path.join(env.MEMESH_DIR!, 'config.json'), JSON.stringify({ updateCheck: false, autoUpdate: 'off' }));
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, '.codex-plugin/plugin.json'), 'utf8'));
  const A = `synthetic-a-${randomUUID()}`, B = `synthetic-b-${randomUUID()}`;
  const hook = (event: string, session: string) => {
    const commands = manifest.hooks.hooks[event].flatMap((group: { hooks: Array<{ command: string; timeout: number }> }) => group.hooks)
      .filter((entry: { command: string }) => entry.command.endsWith('/scripts/hooks/messages.js'));
    expect(commands).toHaveLength(1);
    const entry = commands[0];
    const script = entry.command.replace('${CLAUDE_PLUGIN_ROOT}', runtime);
    const r = spawnSync(process.execPath, [script], { cwd: home, env, encoding: 'utf8', timeout: entry.timeout * 1000,
      input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: home }) });
    expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
    expect(() => process.kill(r.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    return r.stdout;
  };
  const client = new Client({ name: 'codex-mcp-client', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(runtime, 'dist/mcp/server.js')], cwd: home, env: env as Record<string, string>, stderr: 'pipe' });
  transport.stderr?.on('data', () => { /* drain the isolated server's diagnostics */ });
  let pid: number | null = null;
  try {
    expect(hook('SessionStart', A)).toBe('');
    expect(hook('SessionStart', B)).toBe('');
    await client.connect(transport); pid = transport.pid;
    const call = (session: string, args: Record<string, unknown>) => client.callTool({ name: 'message', arguments: args, _meta: { threadId: session } }, undefined, { timeout: 10000 });
    const data = (result: Awaited<ReturnType<typeof call>>) => {
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    const discovered = data(await call(A, { action: 'discover' }));
    expect(discovered.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: A, host: 'codex', online: true }),
      expect.objectContaining({ address: B, host: 'codex', online: true }),
    ]));
    const body = `HEAD-${randomUUID()}\nMIDDLE-${randomUUID()}\nTAIL-${randomUUID()}`;
    const sent = data(await call(A, { action: 'send', recipient: B, kind: 'question', body }));
    expect(sent.state).toBe('queued');
    const output = JSON.parse(hook('UserPromptSubmit', B)).hookSpecificOutput;
    expect(output.hookEventName).toBe('UserPromptSubmit');
    const delivered = JSON.parse(output.additionalContext.split('\n')[1]);
    expect(delivered).toMatchObject({ id: sent.message_id, sender: A, body });
    expect(data(await call(A, { action: 'status', message_id: sent.message_id })).messages[0].state).toBe('delivered');
    const replyBody = `REPLY-HEAD-${randomUUID()}\nREPLY-MIDDLE-${randomUUID()}\nREPLY-TAIL-${randomUUID()}`;
    const reply = data(await call(B, { action: 'send', recipient: A, kind: 'result', body: replyBody, reply_to: sent.message_id }));
    expect(reply.state).toBe('queued');
    const returned = JSON.parse(JSON.parse(hook('UserPromptSubmit', A)).hookSpecificOutput.additionalContext.split('\n')[1]);
    expect(returned).toMatchObject({ id: reply.message_id, sender: B, body: replyBody, reply_to: sent.message_id });
    expect(data(await call(A, { action: 'status', message_id: sent.message_id })).messages[0].state).toBe('replied');
    expect((await call(A, { action: 'read', message_id: randomUUID() })).isError).toBe(true);
    expect((await call(A, { action: 'send', recipient: B, kind: 'question', body: 'synthetic-rejected', sender: B })).isError).toBe(true);
  } finally {
    await client.close();
    try {
      if (pid !== null) expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
}, 30000);
