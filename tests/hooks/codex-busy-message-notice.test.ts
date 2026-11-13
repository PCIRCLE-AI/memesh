import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationMessages } from '../../src/core/conversation-messages.js';

describe('Codex PostToolUse whole conversation messages', () => {
  let dir: string, store: ConversationMessages;
  const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-busy-body-'));
    store = new ConversationMessages({ file: path.join(dir, 'messages.db') });
    for (const id of ['sender', session, other]) store.register({ id, host: 'codex', machine: os.hostname(), pid: process.pid, wake: {} });
  });
  afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (body = 'HEAD\nMID\nTAIL', recipient = session) => store.send('sender', { recipient, kind: 'task', body }).message.id;
  const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, HOME: dir, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'graph.db'), MEMESH_HOOK_HOST: 'codex', MEMESH_AUTO_CAPTURE: 'false', CODEX_THREAD_ID: session, ...extra });
  const payload = (id = session) => JSON.stringify({ session_id: id, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  function run(id = session, extra: NodeJS.ProcessEnv = {}) {
    const r = spawnSync(process.execPath, [path.resolve('scripts/hooks/codex-busy-message-notice.js')], { env: env(extra), input: payload(id), encoding: 'utf8', timeout: 10000 });
    expect(r.status, r.stderr).toBe(0); expect(() => process.kill(r.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' })); return r;
  }
  const state = (id: string) => store.status(undefined, id)[0].state;
  const lockPath = () => {
    const folder = path.join(dir, 'codex-busy-message-notice'); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return path.join(folder, `${session}.json.lock`);
  };
  it('emits full sender/recipient/body once, independent of capture, and later emits a new message', () => {
    const id = send(); const context = JSON.parse(run().stdout).hookSpecificOutput;
    expect(context.hookEventName).toBe('PostToolUse'); expect(context.additionalContext).toContain('untrusted data');
    expect(JSON.parse(context.additionalContext.trim().split('\n')[1])).toMatchObject({ id, sender: 'sender', recipient: session, body: 'HEAD\nMID\nTAIL' });
    expect(context.additionalContext).not.toMatch(/poll|fetch|intake/i); expect(state(id)).toBe('delivered'); expect(run().stdout).toBe('');
    const next = send('later'); expect(run().stdout).toContain(next); expect(state(next)).toBe('delivered');
  });
  it('is quiet after read or prior hook delivery and on non-Codex hosts', () => {
    const read = send(); store.read(session, read); const delivered = send(); store.recordHookDelivery(session, [delivered], 'UserPromptSubmit');
    expect(run().stdout).toBe(''); const pending = send(); expect(run(session, { MEMESH_HOOK_HOST: 'claude-code' }).stdout).toBe(''); expect(state(pending)).toBe('queued');
  });
  it('isolates global message IDs by conversation instead of broadcasting a principal message', () => {
    const a = send('only A'), b = send('only B', other);
    expect(run(other, { CODEX_THREAD_ID: other }).stdout).toContain(b); expect(state(a)).toBe('queued');
    expect(run().stdout).toContain(a); expect(state(a)).toBe('delivered');
  });
  it('ignores stale principal override and uses the validated native session', () => {
    const id = send(); expect(run(session, { MEMESH_RECIPIENT: 'wrong-principal' }).stdout).toContain(id);
  });
  it('refuses invalid or mismatched sessions without exposing content', () => {
    const id = send(); expect(run(other).stdout).toBe(''); expect(run('a'.repeat(129)).stdout).toBe(''); expect(state(id)).toBe('queued');
  });
  it('reports an unregistered conversation without principal fallback', () => {
    const id = send(); expect(run('unregistered', { CODEX_THREAD_ID: 'unregistered' }).stdout).toBe(''); expect(state(id)).toBe('queued');
    const outcomes = fs.readFileSync(path.join(dir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(outcomes.at(-1)).toMatchObject({ outcome: 'error', reason: 'uncaught Error' });
  });
  it('does not starve a fresh message behind 500 seen but still queued messages', () => {
    const seen = Array.from({ length: 500 }, (_, i) => send(`seen-${i}`));
    const folder = path.dirname(lockPath()); fs.writeFileSync(path.join(folder, `${session}.json`), JSON.stringify({ notified: seen }), { mode: 0o600 });
    const fresh = send('FRESH_AFTER_500'); const output = run().stdout;
    expect(output).toContain('FRESH_AFTER_500'); expect(output).not.toContain('seen-'); expect(state(fresh)).toBe('delivered');
    expect(store.status().filter(row => seen.includes(row.id) && row.state === 'queued')).toHaveLength(500);
  });
  it('keeps overflow queued and delivers it in the next whole-envelope batch', () => {
    const a = send('A'.repeat(4500)), b = send('B'.repeat(4500)); expect(run().stdout).toContain(a); expect(state(b)).toBe('queued');
    expect(run().stdout).toContain(b); expect(state(b)).toBe('delivered');
  });
  it('does not deliver the same message twice across eight concurrent Bash hooks', async () => {
    const id = send();
    const outputs = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('scripts/hooks/codex-busy-message-notice.js')], { env: env(), stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.once('error', reject);
      child.once('close', code => { try { expect(code).toBe(0); expect(() => process.kill(child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' })); resolve(output); } catch (e) { reject(e); } });
      child.stdin.end(payload());
    })));
    expect(outputs.filter(Boolean)).toHaveLength(1); expect(state(id)).toBe('delivered');
  });
  it('leaves live-owner locks intact and recovers dead-owner locks', () => {
    const id = send(), lock = lockPath(); fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    expect(run().stdout).toBe(''); expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`);
    fs.writeFileSync(lock, '2147483647\n'); expect(run().stdout).toContain(id); expect(fs.existsSync(lock)).toBe(false);
  });
  it('recovers an incomplete stale lock', () => {
    const id = send(), lock = lockPath(); fs.writeFileSync(lock, '', { mode: 0o600 });
    const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
    expect(run().stdout).toContain(id); expect(fs.existsSync(lock)).toBe(false);
  });
  it.runIf(process.platform !== 'win32')('refuses a lock readable by others', () => {
    const id = send(), lock = lockPath(); fs.writeFileSync(lock, '2147483647\n', { mode: 0o644 }); fs.chmodSync(lock, 0o644);
    expect(run().stdout).toBe(''); expect(fs.existsSync(lock)).toBe(true); expect(state(id)).toBe('queued');
  });
  it.runIf(process.platform !== 'win32')('does not follow a lock symlink or mutate its target', () => {
    const id = send(), lock = lockPath(), target = path.join(dir, 'sentinel'); fs.writeFileSync(target, '2147483647\n', { mode: 0o600 }); fs.symlinkSync(target, lock);
    expect(run().stdout).toBe(''); expect(fs.lstatSync(lock).isSymbolicLink()).toBe(true); expect(fs.readFileSync(target, 'utf8')).toBe('2147483647\n'); expect(state(id)).toBe('queued');
  });
  it.skipIf(process.platform === 'win32')('rolls back seen state on EPIPE, then delivers the pending whole body', async () => {
    const id = send(); const child = spawn(process.execPath, [path.resolve('scripts/hooks/codex-busy-message-notice.js')], { env: env(), stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 });
    child.stdout.destroy(); child.stdin.end(payload()); await new Promise(resolve => child.once('close', resolve));
    expect(() => process.kill(child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' })); expect(state(id)).toBe('queued'); expect(run().stdout).toContain(id); expect(state(id)).toBe('delivered');
  });
  it('keeps the declared Codex Bash matcher wired to this hook', () => {
    const manifest = JSON.parse(fs.readFileSync('.codex-plugin/plugin.json', 'utf8'));
    expect(manifest.hooks.hooks.PostToolUse.some((item: { matcher: string; hooks: Array<{ command: string }> }) => item.matcher === 'Bash' && item.hooks.some(h => h.command.endsWith('/scripts/hooks/codex-busy-message-notice.js')))).toBe(true);
  });
});
