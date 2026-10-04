import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { releaseCodexQueue, type SpawnCodexProxy } from '../../src/host-adapters/codex-queue-release.js';
import { createCodexCliQueueAdapter } from '../../src/host-adapters/codex-cli-queue.js';

// Stands in for `codex app-server proxy`: pipes stdio to a socket, exits 1, or
// hangs silently ('stubborn' also ignores SIGTERM). It exits when its stdin
// closes, so it cannot outlive the test. Like Codex, it gives up on a client
// that sends frames before the 101. It forwards stdin a moment late, as a pipe
// on Linux may, so bytes written just before the client kills it can be lost.
const FAKE_PROXY = `
const target = process.argv[1];
if (target === 'exit-1') process.exit(1);
process.stdin.on('end', () => process.exit(0));
if (target === 'stubborn') process.on('SIGTERM', () => {});
if (target === 'hang' || target === 'stubborn') {
  process.stdin.resume();
} else {
  const socket = require('node:net').connect(target);
  let upgraded = false;
  let head = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    if (!upgraded) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\\r\\n\\r\\n');
      if (end >= 0 && head.length > end + 4) process.exit(3);
    }
    setTimeout(() => socket.write(chunk), 20);
  });
  socket.on('data', (chunk) => { upgraded = true; process.stdout.write(chunk); });
  socket.on('close', () => process.exit(0));
}`;

function fakeProxy(target: string) {
  const calls: Array<{ command: string; args: string[]; child: ChildProcess }> = [];
  const spawnProxy: SpawnCodexProxy = (command, args, options) => {
    const child = spawn(process.execPath, ['-e', FAKE_PROXY, target], options);
    calls.push({ command, args, child });
    return child;
  };
  return { spawnProxy, calls };
}

async function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the proxy child is still running')), 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(undefined); });
    });
  }
  return { code: child.exitCode, signal: child.signalCode };
}

const MEMESH_ITEM = { id: 'sub-1', input: [{ type: 'text', text: '{"message_type":"memesh_message","delivery_id":"d-1"}' }] };
const OTHER_MEMESH_ITEM = { ...MEMESH_ITEM, id: 'sub-2' };

// The text the Codex queue adapter really queues now: a notice, not the full message.
async function queuedNoticeText(): Promise<string> {
  let text = '';
  const adapter = createCodexCliQueueAdapter({
    authenticate: () => true,
    run: async (_command, args) => { text = args[4] ?? ''; return { status: 0, stdout: '', stderr: '' }; },
  });
  await adapter.dispatch!({
    dispatch_id: 'd-1', attempt_id: 'a-1', project: 'project-1', principal_id: 'principal-1',
    session_instance_id: 'thread-1', connection_id: 'c-1', generation: 1, hops: 1, untrusted_payload: true,
    envelope: {
      message_id: 'm-1', project: 'project-1', sender: 'sender-1', sender_host: null, recipient: 'thread-1',
      target_kind: 'session', content_type: 'text/plain', correlation_id: null, reply_to: null,
      privacy: 'private', created_at: '2026-10-04T00:00:00.000Z', payload: 'body', provenance: {},
    },
  });
  return text;
}
const NOTICE_ITEM = { id: 'sub-1', input: [{ type: 'text', text: await queuedNoticeText() }] };
const OTHER_NOTICE_ITEM = { ...NOTICE_ITEM, id: 'sub-2' };
const USER_ITEM = { id: 'user-1', input: [{ type: 'text', text: 'Reply with exactly: USER-ITEM' }] };
const STARTED = { result: { turn: { id: 'turn-1', status: 'inProgress' } } };
const rpcError = (message: string) => ({ error: { code: -32600, message } });

describe('releaseCodexQueue', () => {
  it.skipIf(process.platform === 'win32').each([
    ['started: only MeMesh input is queued', [MEMESH_ITEM, OTHER_MEMESH_ITEM], null, STARTED, { status: 'started' }],
    ['started: queued MeMesh notices are MeMesh input', [NOTICE_ITEM, OTHER_NOTICE_ITEM], null, STARTED, { status: 'started' }],
    ['other_input: user input waits beside a MeMesh notice', [USER_ITEM, NOTICE_ITEM], null, null, { status: 'other_input' }],
    ['empty: the submission is no longer listed', [USER_ITEM, OTHER_MEMESH_ITEM], null, null, { status: 'empty' }],
    ['empty: the submission was taken before the start', [MEMESH_ITEM], null,
      rpcError('queued submission not found: sub-1'), { status: 'empty' }],
    ['busy', [MEMESH_ITEM], null, rpcError('thread already has an active or pending turn'), { status: 'busy' }],
    ['other_input: input MeMesh did not queue is waiting', [USER_ITEM, MEMESH_ITEM], null, null, { status: 'other_input' }],
    ['other_input: the queue has another page', [MEMESH_ITEM], 'cursor-2', null, { status: 'other_input' }],
    ['other_input: the submission may be on a later page', [OTHER_MEMESH_ITEM], 'cursor-2', null, { status: 'other_input' }],
  ])('%s', async (_name, queue, nextCursor, startAnswer, expected) => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memesh-codex-release-'));
    const socketPath = `${tempDir}/control.sock`;
    const frames: Array<Record<string, unknown>> = [];
    const urls: Array<string | undefined> = [];
    let pongs = 0;
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      urls.push(request.url);
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on('pong', () => { pongs += 1; });
        webSocket.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          frames.push(frame);
          if (frame.method === 'initialize') {
            // A ping before the reply; the client's pong precedes its next request.
            webSocket.ping();
            webSocket.send(JSON.stringify({ id: frame.id, result: {} }));
          }
          if (frame.method === 'thread/queue/start') webSocket.send(JSON.stringify({ id: frame.id, ...startAnswer }));
          if (frame.method !== 'thread/queue/list') return;
          // A large notification in two fragments comes before the reply.
          const note = JSON.stringify({ method: 'thread/status/changed', params: { pad: 'x'.repeat(70_000) } });
          webSocket.send(note.slice(0, 100), { fin: false });
          webSocket.send(note.slice(100), { fin: true });
          webSocket.send(JSON.stringify({ id: frame.id, result: { data: queue, nextCursor } }));
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const { spawnProxy, calls } = fakeProxy(socketPath);
    try {
      await expect(releaseCodexQueue('thread-1', 'sub-1', { spawn: spawnProxy })).resolves.toEqual(expected);
      expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
        { command: 'codex', args: ['app-server', 'proxy'] },
      ]);
      expect(urls).toEqual(['/rpc']);
      expect(frames.map(frame => frame.method)).toEqual([
        'initialize', 'initialized', 'thread/queue/list', ...(startAnswer ? ['thread/queue/start'] : []),
      ]);
      expect(frames[0]).toMatchObject({ params: { capabilities: { experimentalApi: true } } });
      expect(frames[2]).toMatchObject({ params: { threadId: 'thread-1' } });
      if (startAnswer) {
        expect(frames[3]).toMatchObject({ params: { threadId: 'thread-1', queuedSubmissionId: 'sub-1' } });
      }
      expect(pongs).toBe(1);
      await exitOf(calls[0].child);
    } finally {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>(resolve => webSocketServer.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports no_daemon when the proxy exits 1', async () => {
    const { spawnProxy, calls } = fakeProxy('exit-1');
    await expect(releaseCodexQueue('thread-1', 'sub-1', { spawn: spawnProxy })).resolves.toEqual({
      status: 'unavailable', reason: 'no_daemon',
    });
    await expect(exitOf(calls[0].child)).resolves.toEqual({ code: 1, signal: null });
  });

  it('times out and kills a proxy that never answers', async () => {
    const { spawnProxy, calls } = fakeProxy('hang');
    const started = Date.now();
    await expect(releaseCodexQueue('thread-1', 'sub-1', { spawn: spawnProxy, timeout_ms: 500 })).resolves.toEqual({
      status: 'unavailable', reason: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    const exit = await exitOf(calls[0].child);
    if (process.platform !== 'win32') expect(exit).toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('bounds the call when the proxy ignores SIGTERM, then kills it', async () => {
    const { spawnProxy, calls } = fakeProxy('stubborn');
    const started = Date.now();
    const result = await Promise.race([
      releaseCodexQueue('thread-1', 'sub-1', { spawn: spawnProxy, timeout_ms: 500 }),
      new Promise((resolve) => setTimeout(() => resolve('STILL_PENDING'), 1_500)),
    ]);
    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_500);
    const exit = await exitOf(calls[0].child);
    if (process.platform !== 'win32') expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
  });
});
