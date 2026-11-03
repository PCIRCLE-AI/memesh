// The bridge's local control socket. Whoever holds the listen IS the bridge: the
// operating system gives it to one process at a time, so nobody has to judge
// another process by its command line. A bridge is known by answering here with
// this data dir's name, and it stops when asked here. Nothing signals a pid.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { NetworkError, networkDir } from './types.js';

// The limit a Unix socket path must fit under, the same number the agent router uses.
const SOCKET_PATH_MAX_BYTES = 103;
const PROBE_DEADLINE_MS = 4_000;
const REQUEST_DEADLINE_MS = 2_000;
const REQUEST_MAX_BYTES = 256;
const REPLY_MAX_BYTES = 8 * 1024;
const STARTUP_LOCK_WAIT_MS = 5_000;
const STARTUP_LOCK_STALE_MS = 30_000;

/** A named pipe on Windows, which has no socket files. Unverified there: no Windows machine has run it. */
export function controlPath(dataDir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\memesh-bridge-${createHash('sha256').update(dataDir).digest('hex').slice(0, 32)}`;
  }
  return path.join(networkDir(dataDir), 'bridge.sock');
}

export function controlPathFits(dataDir: string): boolean {
  return Buffer.byteLength(controlPath(dataDir)) <= SOCKET_PATH_MAX_BYTES;
}

export function assertControlPathFits(dataDir: string): void {
  if (controlPathFits(dataDir)) return;
  throw new NetworkError(
    'invalid_option',
    `The MeMesh data folder's path is too long for this computer's local sockets (${dataDir}). Use a shorter one with MEMESH_DIR or MEMESH_DB_PATH.`,
  );
}

function dataDirIdentity(dataDir: string): string {
  try {
    return fs.realpathSync(dataDir);
  } catch {
    return dataDir; // Nothing there yet.
  }
}

interface Reply { data_dir: string; pid: number; ready: boolean }

export type BridgeProbe =
  | { kind: 'running'; pid: number; ready: boolean }
  | { kind: 'not-running' }
  | { kind: 'unresponsive' };

function parseReply(line: string, dataDir: string): Reply | null {
  try {
    const reply = JSON.parse(line) as Partial<Reply> | null;
    const valid = Number.isSafeInteger(reply?.pid) && typeof reply?.ready === 'boolean';
    return valid && reply?.data_dir === dataDirIdentity(dataDir) ? reply as Reply : null;
  } catch {
    return null;
  }
}

/** Send one request and read one line. Resolves null when connected but given no valid answer in time. */
function request(dataDir: string, op: 'hello' | 'stop', deadlineMs: number): Promise<Reply | 'not-running' | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(controlPath(dataDir));
    let text = '';
    const finish = (result: Reply | 'not-running' | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), deadlineMs);
    socket.once('connect', () => socket.write(`${JSON.stringify({ op })}\n`));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.length > REPLY_MAX_BYTES) finish(null);
      const newline = text.indexOf('\n');
      if (newline === -1) return;
      finish(parseReply(text.slice(0, newline), dataDir));
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // Refused: a socket file nobody holds. Absent: nothing was ever here.
      finish(['ECONNREFUSED', 'ENOENT', 'ENOTDIR'].includes(String(err.code)) ? 'not-running' : null);
    });
    socket.once('close', () => finish(null));
  });
}

export async function probeBridge(dataDir: string, deadlineMs: number = PROBE_DEADLINE_MS): Promise<BridgeProbe> {
  if (!controlPathFits(dataDir)) return { kind: 'not-running' };
  const reply = await request(dataDir, 'hello', deadlineMs);
  if (reply === 'not-running') return { kind: 'not-running' };
  return reply === null ? { kind: 'unresponsive' } : { kind: 'running', pid: reply.pid, ready: reply.ready };
}

/** Ask the bridge to stop. True when it acknowledged. */
export async function askBridgeToStop(dataDir: string): Promise<boolean> {
  const reply = await request(dataDir, 'stop', PROBE_DEADLINE_MS);
  return reply !== null && reply !== 'not-running';
}

/** Only one starter may judge and replace a stale socket at a time, or one could remove another's fresh one. */
async function withStartupLock<T>(dataDir: string, use: () => Promise<T>): Promise<T> {
  const lock = path.join(networkDir(dataDir), 'bridge.sock.startup.lock');
  const giveUpAt = Date.now() + STARTUP_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (startupLockIsStale(lock)) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() >= giveUpAt) throw new Error('Another network bridge is starting and did not finish.', { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await use();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Held by a process that is gone, or for longer than any start takes. Only the holder's existence is asked. */
function startupLockIsStale(lock: string): boolean {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs >= STARTUP_LOCK_STALE_MS) return true;
    process.kill(Number(fs.readFileSync(lock, 'utf8').trim()), 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function listen(server: net.Server, target: string): Promise<'listening' | 'in-use'> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') resolve('in-use');
      else reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve('listening');
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(target);
  });
}

function removeStaleSocket(target: string): void {
  if (process.platform === 'win32') return; // A pipe nobody holds is simply gone.
  if (!fs.lstatSync(target).isSocket()) {
    throw new Error(`${target} exists and is not a socket, so the network bridge cannot use it.`);
  }
  fs.unlinkSync(target);
}

export interface ControlHandlers {
  isReady(): boolean;
  stop(): void;
  onProblem(message: string): void;
}

function parseOp(line: string): 'hello' | 'stop' | null {
  try {
    const { op } = JSON.parse(line) as { op?: unknown };
    return op === 'hello' || op === 'stop' ? op : null;
  } catch {
    return null;
  }
}

function serveConnection(socket: net.Socket, identity: string, handlers: ControlHandlers): void {
  let text = '';
  socket.setTimeout(REQUEST_DEADLINE_MS, () => socket.destroy());
  socket.on('error', (err) => handlers.onProblem(`Control connection failed: ${err.message}`));
  socket.on('data', (chunk) => {
    text += chunk.toString('utf8');
    if (text.length > REQUEST_MAX_BYTES) {
      socket.destroy();
      return;
    }
    const newline = text.indexOf('\n');
    if (newline === -1) return;
    const op = parseOp(text.slice(0, newline));
    if (op === null) {
      socket.destroy();
      return;
    }
    const reply: Reply = { data_dir: identity, pid: process.pid, ready: handlers.isReady() };
    socket.end(`${JSON.stringify(reply)}\n`, () => {
      if (op === 'stop') handlers.stop();
    });
  });
}

export type ControlHold =
  | { kind: 'held'; close(): void }
  | { kind: 'already-running' }
  | { kind: 'holder-unresponsive' };

/**
 * Take the listen, or find out who has it. A socket that refuses a connection was
 * left by a process that is gone, and is replaced; one that answers, or that
 * accepts and says nothing, belongs to someone and is left alone.
 */
export async function holdControlSocket(dataDir: string, handlers: ControlHandlers): Promise<ControlHold> {
  assertControlPathFits(dataDir);
  const identity = dataDirIdentity(dataDir);
  const target = controlPath(dataDir);
  const server = net.createServer((socket) => serveConnection(socket, identity, handlers));
  server.on('error', (err) => handlers.onProblem(`Control socket failed: ${err.message}`));
  return withStartupLock(dataDir, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await listen(server, target)) === 'listening') {
        return { kind: 'held', close: () => { server.close(); } };
      }
      const probe = await probeBridge(dataDir);
      if (probe.kind === 'running') return { kind: 'already-running' };
      if (probe.kind === 'unresponsive') return { kind: 'holder-unresponsive' };
      removeStaleSocket(target);
    }
    throw new Error('The network bridge control socket stayed in use.');
  });
}
