import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';

describe('Codex PostToolUse message reminder', () => {
  let dir: string;
  let dbPath: string;
  const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const recipient = 'codex-principal';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notice-')); dbPath = path.join(dir, 'db.sqlite'); openDatabase(dbPath); });
  afterEach(() => { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function send() {
    return executeAgentMessageAction(getDatabase(), { action: 'send', project: 'room', sender: 'SECRET-SENDER', recipient, intended_session: session, idempotency_key: randomUUID(), payload: 'SECRET-PAYLOAD' }, { transport: 'mcp', sourceHost: 'test' }) as Promise<{ message_id: string; delivery_id: string }>;
  }
  function run(id = session, host = 'codex') {
    return spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-busy-message-notice.js')], { input: JSON.stringify({ session_id: id, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash' }), env: { ...process.env, HOME: dir, MEMESH_DB_PATH: dbPath, MEMESH_RECIPIENT: recipient, MEMESH_HOOK_HOST: host, CODEX_THREAD_ID: id }, encoding: 'utf8' });
  }
  it('emits only count and fetch guidance once per message per session, then notices a new message', async () => {
    await send();
    const started = performance.now();
    const first = run();
    console.log(`Real PostToolUse hook subprocess: ${(performance.now() - started).toFixed(1)} ms`);
    expect(first.status, first.stderr).toBe(0);
    const context = JSON.parse(first.stdout).hookSpecificOutput;
    expect(context).toMatchObject({ hookEventName: 'PostToolUse', additionalContext: expect.stringMatching(/1.*room.*poll.*fetch/i) });
    expect(first.stdout).not.toMatch(/SECRET-PAYLOAD|SECRET-SENDER/);
    expect(run().stdout).toBe('');
    const outcomes = fs.readFileSync(path.join(dir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ hook: 'codex-busy-message-notice', outcome: 'notified' }),
      expect.objectContaining({ hook: 'codex-busy-message-notice', outcome: 'skipped', reason: 'no waiting messages' }),
    ]));
    await send();
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toMatch(/1.*room/i);
    expect(run(randomUUID()).stdout).toBe(''); // intended for the original session
  });
  it('is quiet after intake and on non-Codex hosts', async () => {
    const message = await send();
    await executeAgentMessageAction(getDatabase(), { action: 'intake', project: 'room', recipient, message_id: message.message_id, idempotency_key: 'intake', intake_state: 'ingested' }, { transport: 'mcp', sourceHost: 'test', hostSession: session });
    expect(run().stdout).toBe('');
    await send();
    expect(run(session, 'claude-code').stdout).toBe('');
  });
  it('notifies each session independently for a shared principal delivery', async () => {
    await executeAgentMessageAction(getDatabase(), { action: 'send', project: 'room', sender: 'sender', recipient, idempotency_key: 'shared', payload: 'hello' }, { transport: 'mcp', sourceHost: 'test' });
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toContain('1 new message');
    const another = randomUUID();
    expect(JSON.parse(run(another).stdout).hookSpecificOutput.additionalContext).toContain('1 new message');
    expect(run(another).stdout).toBe('');
  });
  it('uses the normal Codex session recipient without an explicit override', async () => {
    await executeAgentMessageAction(getDatabase(), { action: 'send', project: 'room', sender: 'sender', recipient: `codex-thread-${session}`, intended_session: session, idempotency_key: 'automatic', payload: 'hello' }, { transport: 'mcp', sourceHost: 'test' });
    const result = spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-busy-message-notice.js')], { input: JSON.stringify({ session_id: session, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash' }), env: { ...process.env, HOME: dir, MEMESH_DB_PATH: dbPath, MEMESH_RECIPIENT: undefined, MEMESH_HOOK_HOST: 'codex', CODEX_THREAD_ID: session }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    if (process.platform === 'win32') expect(result.stdout).toBe('');
    else expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(`codex-thread-${session}`);
  });
  it('does not starve a later message behind 500 already-notified unread messages', async () => {
    for (let i = 0; i < 500; i++) {
      await executeAgentMessageAction(getDatabase(), { action: 'send', project: `room-${String(i).padStart(3, '0')}`, sender: 'sender', recipient, idempotency_key: 'backlog', payload: 'hello' }, { transport: 'mcp', sourceHost: 'test' });
    }
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toContain('room-499');
    await executeAgentMessageAction(getDatabase(), { action: 'send', project: 'room-zzz', sender: 'sender', recipient, idempotency_key: 'later', payload: 'hello' }, { transport: 'mcp', sourceHost: 'test' });
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toContain('room-zzz');
  });
  it('does not notify the same message twice when Bash hooks run concurrently', async () => {
    await send();
    const launches = Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('scripts/hooks/codex-busy-message-notice.js')], { env: { ...process.env, HOME: dir, MEMESH_DB_PATH: dbPath, MEMESH_RECIPIENT: recipient, MEMESH_HOOK_HOST: 'codex', CODEX_THREAD_ID: session }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`hook exit ${code}`)));
      child.stdin.end(JSON.stringify({ session_id: session, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash' }));
    }));
    const outputs = await Promise.all(launches);
    expect(outputs.filter(Boolean)).toHaveLength(1);
  });
  it('leaves a live owner lock alone and recovers a dead owner lock', async () => {
    await send();
    const lockDir = path.join(dir, 'codex-busy-message-notice');
    fs.mkdirSync(lockDir, { mode: 0o700 });
    const lock = path.join(lockDir, `${session}.json.lock`);
    fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    expect(run().stdout).toBe('');
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`);
    fs.writeFileSync(lock, '2147483647\n');
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toContain('1 new message');
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('recovers an incomplete old lock', async () => {
    await send();
    const lockDir = path.join(dir, 'codex-busy-message-notice');
    fs.mkdirSync(lockDir, { mode: 0o700 });
    const lock = path.join(lockDir, `${session}.json.lock`);
    fs.writeFileSync(lock, '', { mode: 0o600, flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toContain('1 new message');
    expect(fs.existsSync(lock)).toBe(false);
  });
  it.runIf(process.platform !== 'win32')('refuses a lock readable by other users', async () => {
    await send();
    const lockDir = path.join(dir, 'codex-busy-message-notice');
    fs.mkdirSync(lockDir, { mode: 0o700 });
    const lock = path.join(lockDir, `${session}.json.lock`);
    fs.writeFileSync(lock, '2147483647\n', { mode: 0o644 });
    fs.chmodSync(lock, 0o644);
    expect(run().stdout).toBe('');
    expect(fs.existsSync(lock)).toBe(true);
  });
  it.runIf(process.platform !== 'win32')('does not follow a lock symlink or alter its target', async () => {
    await send();
    const lockDir = path.join(dir, 'codex-busy-message-notice');
    fs.mkdirSync(lockDir, { mode: 0o700 });
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, '2147483647\n', { mode: 0o600, flag: 'wx' });
    const lock = path.join(lockDir, `${session}.json.lock`);
    fs.symlinkSync(target, lock);
    expect(run().stdout).toBe('');
    expect(fs.lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('2147483647\n');
  });
  it('does not suppress a Codex notice-only host acceptance', async () => {
    const message = await send();
    registerAgentSession('room', recipient, { sessionId: session, adapterKind: 'codex-cli-queue' });
    const db = getDatabase();
    const connection = db.prepare('SELECT connection_id FROM agent_session_connections WHERE session_instance_id = ?').get(session) as { connection_id: string };
    db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, completed_at) VALUES ('attempt', ?, 'room', ?, ?, ?, 1, 'router', 1, 'adapter_returned', CURRENT_TIMESTAMP)`).run(message.delivery_id, recipient, session, connection.connection_id);
    db.prepare(`INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json) VALUES ('accept', 'attempt', ?, 'codex-cli-queue', '{"content":"notice"}')`).run(message.delivery_id);
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toMatch(/1.*room/i);
  });
  it('wires the Codex plugin PostToolUse Bash matcher to this hook', () => {
    const manifest = JSON.parse(fs.readFileSync('.codex-plugin/plugin.json', 'utf8'));
    expect(manifest.hooks.hooks.PostToolUse.some((item: { matcher: string; hooks: Array<{ command: string }> }) => item.matcher === 'Bash' && item.hooks.some(h => h.command.endsWith('/scripts/hooks/codex-busy-message-notice.js')))).toBe(true);
  });
});
