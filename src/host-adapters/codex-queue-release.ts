import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

const DEFAULT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 1_000;
const MAX_READ_BYTES = 1024 * 1024;
const QUEUE_PAGE = 100;
// What MeMesh queues: a notice now, the full message before (still possibly waiting in a queue).
const MEMESH_QUEUED_PREFIXES = ['{"message_type":"memesh_message_notice"', '{"message_type":"memesh_message"'];

/** `other_input`: something MeMesh did not queue is waiting too, so nothing is started. */
export type CodexQueueRelease =
  | { status: 'started' | 'empty' | 'busy' | 'other_input' }
  | { status: 'unavailable'; reason: 'no_daemon' | 'timeout' | 'rejected' | 'failed' };

export type SpawnCodexProxy = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ReleaseCodexQueueOptions {
  timeout_ms?: number;
  spawn?: SpawnCodexProxy;
}

interface RpcReply {
  id?: unknown;
  result?: { data?: unknown; nextCursor?: unknown };
  error?: { message?: unknown };
}

interface QueuedItem {
  id?: unknown;
  input?: Array<{ type?: unknown; text?: unknown }>;
}

/**
 * Ask Codex to start one queued MeMesh submission now (`thread/queue/start`)
 * through `codex app-server proxy`, which speaks WebSocket over its stdio.
 * Codex can leave a `codex queue` item unstarted after an interrupted turn.
 * Codex runs the rest of the queue after that turn, so nothing is started
 * while input MeMesh did not queue is waiting. The router runs without
 * third-party modules, so this carries its own small WebSocket client.
 * Never throws; always kills the proxy.
 */
export async function releaseCodexQueue(
  threadId: string,
  queuedSubmissionId: string,
  options: ReleaseCodexQueueOptions = {},
): Promise<CodexQueueRelease> {
  let child: ChildProcess;
  try {
    child = (options.spawn ?? spawn)('codex', ['app-server', 'proxy'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return { status: 'unavailable', reason: 'failed' };
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CodexQueueRelease>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unavailable', reason: 'timeout' }), options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([attemptRelease(child, threadId, queuedSubmissionId), timeout]);
  } finally {
    clearTimeout(timer);
    stop(child);
  }
}

async function attemptRelease(
  child: ChildProcess,
  threadId: string,
  queuedSubmissionId: string,
): Promise<CodexQueueRelease> {
  const exitCode = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  try {
    const { stdin, stdout } = child;
    if (!stdin || !stdout) throw new Error('Codex proxy has no stdio.');
    stdin.on('error', () => {});
    const send = (opcode: number, payload: Buffer) => stdin.write(clientFrame(opcode, payload));
    const incoming = serverMessages(stdout, (payload) => send(0xa, payload));
    const reply = async (id: number): Promise<RpcReply> => {
      for (;;) {
        const next = await incoming.next();
        if (next.done) throw new Error('Codex proxy closed.');
        const message = JSON.parse(next.value) as RpcReply;
        if (message.id === id) return message;
      }
    };
    const call = (id: number, method: string, params: object) => {
      send(0x1, Buffer.from(JSON.stringify({ id, method, params })));
      return reply(id);
    };

    stdin.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    // Codex never answers a client whose frames arrive before its 101 response.
    const status = await incoming.next();
    if (status.done || !status.value.startsWith('HTTP/1.1 101')) throw new Error('Codex proxy refused the upgrade.');
    const initialized = await call(1, 'initialize', {
      clientInfo: { name: 'memesh-host-adapter', version: '1' },
      // thread/queue/start is an experimental Codex app-server method.
      capabilities: { experimentalApi: true },
    });
    if (initialized.error) return { status: 'unavailable', reason: 'rejected' };
    send(0x1, Buffer.from(JSON.stringify({ method: 'initialized', params: {} })));
    const listed = await call(2, 'thread/queue/list', { threadId, limit: QUEUE_PAGE });
    const items = listed.result?.data;
    if (listed.error || !Array.isArray(items)) return { status: 'unavailable', reason: 'rejected' };
    const morePages = Boolean(listed.result?.nextCursor);
    // Only a complete listing can show that the submission has left the queue.
    if (!morePages && !items.some((item: QueuedItem) => item.id === queuedSubmissionId)) return { status: 'empty' };
    if (morePages || !items.every(isMemeshSubmission)) return { status: 'other_input' };
    const started = await call(3, 'thread/queue/start', { threadId, queuedSubmissionId });
    if (!started.error) return { status: 'started' };
    const message = String(started.error.message);
    // Not found: Codex took it between the list and the start.
    if (/queued submission not found|queue is empty/i.test(message)) return { status: 'empty' };
    if (/active or pending turn/i.test(message)) return { status: 'busy' };
    return { status: 'unavailable', reason: 'rejected' };
  } catch {
    // The proxy exits 1 when no app-server daemon owns the control socket.
    child.kill();
    return { status: 'unavailable', reason: await exitCode === 1 ? 'no_daemon' : 'failed' };
  }
}

/** SIGTERM, then SIGKILL if the proxy is still running a moment later. */
function stop(child: ChildProcess): void {
  child.kill();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const escalate = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  escalate.unref();
  child.once('exit', () => clearTimeout(escalate));
}

function isMemeshSubmission(item: QueuedItem): boolean {
  return Array.isArray(item.input) && item.input.length > 0 && item.input.every((part) => {
    const text = part.text;
    return part.type === 'text' && typeof text === 'string'
      && MEMESH_QUEUED_PREFIXES.some((prefix) => text.startsWith(prefix));
  });
}

/** A masked client frame; every payload here is far below 64 KiB. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length < 126
    ? Buffer.from([0x80 | payload.length])
    : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([
    Buffer.from([0x80 | opcode]),
    length,
    mask,
    Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4])),
  ]);
}

/** The HTTP status line of the upgrade, then text messages; answers pings, ends on close. */
async function* serverMessages(stdout: Readable, pong: (payload: Buffer) => void): AsyncGenerator<string> {
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let read = 0;
  let fragments: Buffer[] = [];
  for await (const chunk of stdout as AsyncIterable<Buffer>) {
    read += chunk.length;
    if (read > MAX_READ_BYTES) throw new Error('Codex proxy sent too much data.');
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) continue;
      const status = buffer.subarray(0, buffer.indexOf('\r\n')).toString('latin1');
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      yield status;
    }
    for (let frame = parseFrame(buffer); frame; frame = parseFrame(buffer)) {
      buffer = buffer.subarray(frame.size);
      if (frame.opcode === 0x8) return;
      if (frame.opcode === 0x9) pong(frame.payload);
      if (frame.opcode > 0x2) continue;
      fragments.push(frame.payload);
      if (frame.fin) {
        yield Buffer.concat(fragments).toString('utf8');
        fragments = [];
      }
    }
  }
}

function parseFrame(buffer: Buffer): { fin: boolean; opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null;
  if (buffer[1] & 0x80) throw new Error('Codex proxy sent a masked frame.');
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return {
    fin: (buffer[0] & 0x80) !== 0,
    opcode: buffer[0] & 0x0f,
    payload: buffer.subarray(offset, offset + length),
    size: offset + length,
  };
}
