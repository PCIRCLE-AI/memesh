import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationMessages, renderConversationMessage } from '../../src/core/conversation-messages.js';
import { startConversationChannel } from '../../src/host-runtime/conversation-channel.js';
import { buildCredentialFreeBaseEnv, buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';

const roots: string[] = [];
const sessions: Array<{ close(): Promise<void> }> = [];
const stores: ConversationMessages[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => {});
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* Runtime already closed its store. */ } }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('compiled conversation Channel entry', () => {
  it('initializes and pushes over real stdio without consulting a nonexistent legacy config/token', async () => {
    const f = fixture();
    const client = new Client({ name: 'claude-code', version: '1' });
    const env = buildIsolatedRuntimeEnv(buildCredentialFreeBaseEnv(process.env), {
      runtimeHome: f.root, memeshDir: f.root, dbPath: path.join(f.root, 'knowledge-graph.db'),
    });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../../dist/host-runtime/claude.js', import.meta.url)), '--config', path.join(f.root, 'missing-legacy.json')],
      cwd: f.root, stderr: 'pipe', env: { ...env, CLAUDE_CODE_SESSION_ID: 'B', MEMESH_AUTO_UPDATE: 'off', MEMESH_SKIP_UPDATE_CHECK: '1' } });
    const notices: string[] = [];
    client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string() }) }), event => { notices.push(event.params.content); });
    let pid: number | null = null;
    try {
      await client.connect(transport); pid = transport.pid;
      expect(pid).toBeGreaterThan(1);
      expect(client.getServerCapabilities()?.experimental).toHaveProperty('claude/channel');
      const message = f.send();
      await vi.waitFor(() => expect(notices).toEqual([renderConversationMessage(message)]), { timeout: 3500 });
      await vi.waitFor(() => expect(f.store.status('B', message.id)[0].events.map(event => event.event)).toEqual(['queued', 'pushed']), { timeout: 3500 });
      expect(fs.existsSync(path.join(f.root, 'knowledge-graph.db'))).toBe(false);
    } finally { await client.close(); }
    await vi.waitFor(() => {
      expect(transport.pid).toBeNull();
      expect(() => process.kill(pid!, 0)).toThrow();
    });
  });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcch-')); roots.push(root);
  const store = new ConversationMessages({ file: path.join(root, 'messages.db'), busyTimeoutMs: 100 }); stores.push(store);
  for (const id of ['A', 'B', 'C']) store.register({ id, host: 'claude-code', machine: os.hostname(), pid: process.pid, wake: { socket: path.join(root, `${id}.sock`) } });
  const send = (body = 'HEAD\n中間``` untrusted 🧭\nTAIL', recipient = 'B') => store.send('A', { recipient, kind: 'task', body }).message;
  return { root, store, send };
}
function fakeServer() {
  return { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), notification: vi.fn(async (_message: unknown) => {}),
    oninitialized: undefined as (() => void) | undefined, onclose: undefined as (() => void) | undefined };
}
async function start(store: ConversationMessages, server = fakeServer(), onError = vi.fn()) {
  const session = await startConversationChannel({ store, server, hostPid: process.pid, env: { CLAUDE_CODE_SESSION_ID: 'B' }, onError });
  sessions.push(session);
  return { session, server, onError };
}

describe('conversation Channel', () => {
  it('sends actual SDK notifications with whole bounded envelopes and recipient pushed, never delivery', async () => {
    const f = fixture();
    const alreadyPushed = f.send('socket already accepted'); f.store.recordPush('A', alreadyPushed.id, 'claude-socket');
    const delivered = f.send('already read'); f.store.read('B', delivered.id);
    f.send('foreign session', 'C');
    const first = f.send('HEAD\n' + '中'.repeat(1400) + '\nTAIL');
    const second = f.send('SECOND\n' + '文'.repeat(1400) + '\nEND');
    const client = new Client({ name: 'claude-channel-fixture', version: '1' });
    const notices: Array<{ content: string; meta: Record<string, string> }> = [];
    client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), event => { notices.push(event.params); });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = await startConversationChannel({ store: f.store, transport: serverTransport, hostPid: process.pid, env: { CLAUDE_CODE_SESSION_ID: 'B' } }); sessions.push(session);
    try {
      await client.connect(clientTransport);
      await vi.waitFor(() => expect(notices).toHaveLength(2), { timeout: 3500 });
      expect(notices.map(notice => notice.content)).toEqual([renderConversationMessage(first), renderConversationMessage(second)]);
      for (const notice of notices) expect(Buffer.byteLength(notice.content)).toBeLessThanOrEqual(8000);
      expect(notices[0].meta.recipient).toBe('B');
      const row = f.store.status('B', first.id)[0];
      expect(row.events.map(event => event.event)).toEqual(['queued', 'pushed']);
      expect(JSON.parse(row.events[1].detail)).toEqual({ actor: 'B', route: 'claude-channel' });
      expect(f.store.hookBatch('B').ids).toContain(first.id);
      expect(f.store.channelBatch('B', process.pid).ids).toEqual([]);
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(notices).toHaveLength(2);
    } finally { await client.close(); await session.close(); }
  });

  it('preserves matching socket metadata and refuses other host/PID registrations without replacing them', () => {
    const f = fixture();
    const before = f.store.discover().find(row => row.id === 'B');
    f.store.registerChannel('B', process.pid);
    expect(f.store.discover().find(row => row.id === 'B')).toEqual(before);
    expect(() => f.store.registerChannel('B', process.ppid)).toThrow('identity');
    expect(f.store.discover().find(row => row.id === 'B')).toEqual(before);
    f.store.register({ id: 'B', host: 'codex', machine: os.hostname(), pid: process.pid, wake: { thread: 'B' } });
    expect(() => f.store.registerChannel('B', process.pid)).toThrow('identity');
    expect(f.store.discover().find(row => row.id === 'B')?.wake).toEqual({ thread: 'B' });
    expect(() => f.store.registerChannel('new', 0)).toThrow('identity');
    expect(f.store.discover().some(row => row.id === 'new')).toBe(false);
  });

  it('maintains a long-lived store atomically: one notice after a day and deletion after fourteen', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    const f = fixture(); const message = f.send();
    const { server } = await start(f.store); server.oninitialized!();
    vi.setSystemTime(new Date('2026-11-16T00:00:01Z')); await vi.advanceTimersByTimeAsync(1000);
    expect(f.store.status('A').filter(row => row.sender === 'memesh')).toHaveLength(1);
    expect(f.store.status('B', message.id)[0].events.some(event => event.event === 'delivered')).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.store.status('A').filter(row => row.sender === 'memesh')).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-30T00:00:01Z')); await vi.advanceTimersByTimeAsync(60000);
    expect(f.store.status()).toEqual([]);
  });

  it('retries only explicit busy reads on the next bounded poll', async () => {
    vi.useFakeTimers(); const f = fixture(); f.send();
    const batch = vi.spyOn(f.store, 'channelBatch').mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { errcode: 5 }); });
    const { server, onError } = await start(f.store); server.oninitialized!();
    await vi.advanceTimersByTimeAsync(1000); expect(server.notification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(server.notification).toHaveBeenCalledOnce();
    expect(batch).toHaveBeenCalledTimes(2); expect(onError).not.toHaveBeenCalled();
  });

  it.each(['write', 'audit', 'backpressure'])('closes on %s failure without false delivery or repeated output', async failure => {
    vi.useFakeTimers(); const f = fixture(); const message = f.send();
    const server = fakeServer();
    if (failure === 'write') server.notification.mockRejectedValue(new Error('stdout closed'));
    if (failure === 'backpressure') server.notification.mockImplementation(() => new Promise(() => {}));
    if (failure === 'audit') vi.spyOn(f.store, 'recordChannelPush').mockImplementation(() => { throw new Error('audit failed'); });
    const { session, onError } = await start(f.store, server); server.oninitialized!();
    await vi.advanceTimersByTimeAsync(4000); await session.close();
    expect(server.notification).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledOnce(); expect(session.phase).toBe('closed');
    const readback = new ConversationMessages({ file: path.join(f.root, 'messages.db') }); stores.push(readback);
    expect(readback.status('B', message.id)[0].events.map(event => event.event)).toEqual(['queued']);
  });

  it('close during an in-flight notification waits, removes listeners, and cannot write a later push', async () => {
    vi.useFakeTimers(); const f = fixture(); f.send();
    let resolve!: () => void;
    const server = fakeServer(); server.notification.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const record = vi.spyOn(f.store, 'recordChannelPush'); const closed = vi.spyOn(f.store, 'close');
    const listeners = process.listenerCount('SIGTERM');
    const { session } = await start(f.store, server); server.oninitialized!();
    await vi.advanceTimersByTimeAsync(1000);
    const closing = session.close(); await Promise.resolve(); expect(closed).not.toHaveBeenCalled();
    resolve(); await closing;
    expect(record).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
    await vi.advanceTimersByTimeAsync(5000); expect(server.notification).toHaveBeenCalledOnce();
  });

  it('closing before initialization never registers or starts a poll', async () => {
    vi.useFakeTimers(); const f = fixture(); const register = vi.spyOn(f.store, 'registerChannel');
    const { server, session } = await start(f.store); await session.close(); server.oninitialized!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(register).not.toHaveBeenCalled(); expect(server.notification).not.toHaveBeenCalled();
  });

  it('still closes if an error reporter throws', async () => {
    vi.useFakeTimers(); const f = fixture(); f.send();
    const server = fakeServer(); server.notification.mockRejectedValue(new Error('stream failed'));
    const { session } = await start(f.store, server, vi.fn(() => { throw new Error('reporter failed'); })); server.oninitialized!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.phase).toBe('closed'); expect(server.close).toHaveBeenCalledOnce();
  });
});
