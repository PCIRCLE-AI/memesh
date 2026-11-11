// The bridge's local control socket. Whoever holds the listen IS the bridge: the
// operating system gives it to one process at a time, so nobody has to judge
// another process by its command line. A bridge is known by answering here with
// this data dir's name, and it stops when asked here. Nothing signals a pid. Every
// request carries a token from a private file: a named pipe has no file mode, so on
// Windows another local user may reach the pipe, and they get nothing without it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { NetworkError, networkDir } from './types.js';

// The limit a Unix socket path must fit under, the same number the agent router uses.
const SOCKET_PATH_MAX_BYTES = 103;
const PROBE_DEADLINE_MS = 4_000;
const REQUEST_DEADLINE_MS = 2_000;
const REQUEST_MAX_BYTES = 512;
const REPLY_MAX_BYTES = 8 * 1024;
const STARTUP_LOCK_WAIT_MS = 5_000;
const STARTUP_LOCK_STALE_MS = 30_000;
/** A holder writes its pid right after creating the lock; one still empty after this never will. */
const STARTUP_LOCK_EMPTY_STALE_MS = 1_500;

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
    // The native call also gives the stored letter case, so on a case-insensitive
    // disk two spellings of one folder compare equal; the JS one keeps the input's case.
    return fs.realpathSync.native(dataDir);
  } catch {
    return dataDir; // Nothing there yet.
  }
}

interface Reply { data_dir: string; pid: number; ready: boolean }

export type BridgeProbe =
  | { kind: 'running'; pid: number; ready: boolean }
  | { kind: 'not-running' }
  | { kind: 'unresponsive' };

function tokenPath(dataDir: string): string {
  return path.join(networkDir(dataDir), 'control.token');
}

const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

/**
 * The data dir's control token, created once and kept. It is not per bind: a loser
 * must never overwrite what the holder compares against, and two starters both
 * reading one file cannot disagree. A crash leaves it valid, so a restart just uses it.
 */
function ensureControlToken(dataDir: string): string {
  const file = tokenPath(dataDir);
  const existing = readControlToken(dataDir);
  if (existing !== null) return existing;
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, randomBytes(32).toString('hex'), { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
    // A damaged file is replaced; an intact one a concurrent starter just made is kept.
    if (fs.existsSync(file) && readControlToken(dataDir) === null) fs.rmSync(file, { force: true });
    fs.linkSync(temporary, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return readControlToken(dataDir) as string;
}

function readControlToken(dataDir: string): string | null {
  try {
    const token = fs.readFileSync(tokenPath(dataDir), 'utf8');
    return TOKEN_FORMAT.test(token) ? token : null;
  } catch {
    return null;
  }
}

function tokensMatch(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const left = createHash('sha256').update(given).digest();
  return timingSafeEqual(left, createHash('sha256').update(expected).digest());
}

function parseReply(line: string, dataDir: string): Reply | null {
  try {
    const reply = JSON.parse(line) as Partial<Reply> | null;
    const valid = Number.isSafeInteger(reply?.pid) && (reply?.pid as number) > 0 && typeof reply?.ready === 'boolean';
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
    socket.once('connect', () => socket.write(`${JSON.stringify({ op, token: readControlToken(dataDir) })}\n`));
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

interface FileIdentity { dev: number; ino: number }

export function identityOf(file: string): FileIdentity | null {
  try {
    const { dev, ino } = fs.lstatSync(file);
    return { dev, ino };
  } catch {
    return null;
  }
}

const sameFile = (a: FileIdentity | null, b: FileIdentity | null): boolean => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/**
 * Clear a lock judged stale, but only that lock. Judging takes time and another
 * starter may have replaced it meanwhile, so the file is moved aside (atomic) and
 * looked at: if it is not the one judged, it goes straight back. For the moment it
 * is aside a third starter can get in, which is why a holder re-checks its lock
 * before it touches the socket.
 */
export function takeOverStaleLock(lock: string, judged: FileIdentity): void {
  const aside = `${lock}.stale-${process.pid}`;
  try {
    fs.renameSync(lock, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    if (sameFile(identityOf(aside), judged)) return;
    fs.linkSync(aside, lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** Only one starter may judge and replace a stale socket at a time, or one could remove another's fresh one. */
async function withStartupLock<T>(dataDir: string, use: (holdsLock: () => boolean) => Promise<T>): Promise<T> {
  const lock = path.join(networkDir(dataDir), 'bridge.sock.startup.lock');
  const giveUpAt = Date.now() + STARTUP_LOCK_WAIT_MS;
  let mine: FileIdentity;
  for (;;) {
    try {
      // The identity comes from the open file: a starter clearing a stale lock can
      // have this one moved aside for an instant, so the path is not reliable yet.
      const fd = fs.openSync(lock, 'wx', 0o600);
      const { dev, ino } = fs.fstatSync(fd);
      mine = { dev, ino };
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const judged = identityOf(lock);
      if (judged !== null && startupLockIsStale(lock)) {
        takeOverStaleLock(lock, judged);
        continue;
      }
      if (Date.now() >= giveUpAt) throw new Error('Another network bridge is starting and did not finish.', { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await use(() => sameFile(identityOf(lock), mine));
  } finally {
    if (sameFile(identityOf(lock), mine)) fs.rmSync(lock, { force: true });
  }
}

/** Held by a process that is gone, or for longer than any start takes. Only the holder's existence is asked. */
function startupLockIsStale(lock: string): boolean {
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age >= STARTUP_LOCK_STALE_MS) return true;
    const raw = fs.readFileSync(lock, 'utf8').trim();
    // Empty or not a pid: Number('') is 0, and kill(0) would ask about this whole process group.
    if (!/^[1-9][0-9]*$/.test(raw)) return age >= STARTUP_LOCK_EMPTY_STALE_MS;
    process.kill(Number(raw), 0);
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

/** Remove the file the probe judged, not whatever is there by now. Already gone is fine. */
export function removeStaleSocket(target: string, judged: FileIdentity | null): void {
  if (process.platform === 'win32') return; // A pipe nobody holds is simply gone.
  if (!sameFile(identityOf(target), judged)) return;
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

function parseOp(line: string, token: string): 'hello' | 'stop' | null {
  try {
    const request = JSON.parse(line) as { op?: unknown; token?: unknown };
    if (!tokensMatch(request.token, token)) return null;
    return request.op === 'hello' || request.op === 'stop' ? request.op : null;
  } catch {
    return null;
  }
}

function serveConnection(socket: net.Socket, identity: string, token: string, handlers: ControlHandlers): void {
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
    const op = parseOp(text.slice(0, newline), token);
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

export type Ownership = 'ours' | 'lost' | 'unreadable';

export type ControlHold =
  | {
    kind: 'held';
    /**
     * Is the socket path still the file this process bound? Lost only when it is gone
     * or is a different file; any other error is "unreadable", which says nothing
     * about who owns it. On Windows a pipe has no file: always ours.
     */
    ownership(): Ownership;
    stillOurs(): boolean;
    close(): void;
  }
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
  for (let attempt = 0; attempt < 5; attempt++) {
    const held = await withStartupLock(dataDir, async (holdsLock): Promise<ControlHold | 'lost-the-lock'> => {
      const token = ensureControlToken(dataDir);
      const server = net.createServer((socket) => serveConnection(socket, identity, token, handlers));
      server.on('error', (err) => handlers.onProblem(`Control socket failed: ${err.message}`));
      for (let tries = 0; tries < 3; tries++) {
        if ((await listen(server, target)) === 'listening') return heldBy(server, target);
        const judged = identityOf(target);
        const probe = await probeBridge(dataDir);
        if (probe.kind === 'running') return { kind: 'already-running' };
        if (probe.kind === 'unresponsive') return { kind: 'holder-unresponsive' };
        if (!holdsLock()) return 'lost-the-lock';
        removeStaleSocket(target, judged);
      }
      throw new Error('The network bridge control socket stayed in use.');
    });
    if (held !== 'lost-the-lock') return held;
  }
  throw new Error('Another network bridge kept taking over the start.');
}

function heldBy(server: net.Server, target: string): ControlHold {
  let bound = identityOf(target);
  const ownership = (): Ownership => {
    if (process.platform === 'win32') return 'ours';
    let current: FileIdentity;
    try {
      const { dev, ino } = fs.lstatSync(target);
      current = { dev, ino };
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'lost' : 'unreadable';
    }
    bound ??= current; // Unreadable right after binding: the first readable look decides.
    return sameFile(current, bound) ? 'ours' : 'lost';
  };
  const stillOurs = (): boolean => ownership() !== 'lost';
  return {
    kind: 'held',
    ownership,
    stillOurs,
    close: () => {
      // Closing unlinks the path by name, whoever's file it is now. A newer bridge's stays.
      if (stillOurs()) server.close();
      else server.unref();
    },
  };
}
