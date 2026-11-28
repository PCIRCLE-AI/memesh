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
import { parseMembershipAction, type MembershipAction, type MembershipResult } from './membership.js';

// The limit a Unix socket path must fit under, the same number the agent router uses.
const SOCKET_PATH_MAX_BYTES = 103;
const PROBE_DEADLINE_MS = 4_000;
const REQUEST_DEADLINE_MS = 2_000;
const REQUEST_MAX_BYTES = 512;
const REPLY_MAX_BYTES = 8 * 1024;
const STARTUP_LOCK_WAIT_MS = 5_000;
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

interface Reply { data_dir: string; pid: number; ready: boolean; membership?: MembershipResult; error?: string }

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
function request(dataDir: string, op: 'hello' | 'stop' | MembershipAction, deadlineMs: number, expectedPid?: number): Promise<Reply | 'not-running' | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(controlPath(dataDir));
    let text = '';
    const finish = (result: Reply | 'not-running' | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), deadlineMs);
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: typeof op === 'string' ? op : 'membership', ...(typeof op === 'string' ? {} : { action: op }), ...(expectedPid === undefined ? {} : { expected_pid: expectedPid }), token: readControlToken(dataDir) })}\n`));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.length > (typeof op === 'string' ? REPLY_MAX_BYTES : 32 * 1024)) { finish(null); return; }
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
export async function askBridgeToStop(dataDir: string, expectedPid?: number): Promise<boolean> {
  const reply = await request(dataDir, 'stop', PROBE_DEADLINE_MS, expectedPid);
  return reply !== null && reply !== 'not-running';
}

/** Owner-private local action; the single existing endpoint performs remote RPC. */
export async function askBridgeMembership(dataDir: string, action: MembershipAction, expectedPid: number): Promise<MembershipResult> {
  parseMembershipAction(action);
  const reply = await request(dataDir, action, 25_000);
  if (!reply || reply === 'not-running' || reply.pid !== expectedPid) throw new Error('Membership confirmation unavailable; do not assume it completed.');
  if (reply.error) throw new Error(reply.error);
  if (!reply.membership || reply.membership.action !== action.action || reply.membership.network_id !== action.network_id) throw new Error('Invalid membership confirmation.');
  return reply.membership;
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

/** Read a PID lock and inspect the same file generation through one descriptor. */
export function readPidLock(lock: string): { stat: fs.Stats; raw: string } | null {
  const fd = fs.openSync(lock, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    return stat.isFile() ? { stat, raw: fs.readFileSync(fd, 'utf8').trim() } : null;
  } finally { fs.closeSync(fd); }
}

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

function removeStartupClaim(lock: string, owner: string): void {
  try {
    fs.unlinkSync(path.join(lock, owner));
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return;
    throw err;
  }
  removeEmptyStartupLock(lock);
}

function removeEmptyStartupLock(lock: string): void {
  try {
    fs.rmdirSync(lock);
  } catch (err) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
}

export function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function clearDeadStartupLock(lock: string): void {
  try {
    if (fs.lstatSync(lock).isDirectory()) {
      const owners = fs.readdirSync(lock);
      if (owners.length === 0) return removeEmptyStartupLock(lock);
      const owner = owners.length === 1 ? owners[0] : '';
      const match = /^([1-9][0-9]*)-[0-9a-f]{32}$/.exec(owner);
      if (match && processIsGone(Number(match[1]))) removeStartupClaim(lock, owner);
      return;
    }
    const opened = readPidLock(lock);
    if (!opened) return;
    const { stat: judged, raw } = opened;
    const age = Date.now() - judged.mtimeMs;
    const stale = /^[1-9][0-9]*$/.test(raw) ? processIsGone(Number(raw)) : age >= STARTUP_LOCK_EMPTY_STALE_MS;
    // unlink cannot move a new directory claim aside, unlike the legacy rename protocol.
    if (stale && sameFile(identityOf(lock), judged)) fs.unlinkSync(lock);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' && fs.lstatSync(lock).isDirectory()) return;
    if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(code ?? '')) throw err;
  }
}

/** Only one starter may judge and replace a stale socket at a time. */
async function withStartupLock<T>(dataDir: string, use: (holdsLock: () => boolean) => Promise<T>): Promise<T> {
  const lock = path.join(networkDir(dataDir), 'bridge.sock.startup.lock');
  const giveUpAt = Date.now() + STARTUP_LOCK_WAIT_MS;
  const owner = `${process.pid}-${randomBytes(16).toString('hex')}`;
  const prepared = fs.mkdtempSync(`${lock}.pending-`);
  let acquired = false;
  try {
    fs.writeFileSync(path.join(prepared, owner), '', { mode: 0o600, flag: 'wx' });
    for (;;) {
      try {
        // A published lock is never empty: rename cannot replace another live claim.
        fs.renameSync(prepared, lock);
        acquired = true;
        break;
      } catch (err) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
        clearDeadStartupLock(lock);
        if (Date.now() >= giveUpAt) throw new Error('Another network bridge is starting and did not finish.', { cause: err });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return await use(() => fs.existsSync(path.join(lock, owner)));
  } finally {
    if (acquired) removeStartupClaim(lock, owner);
    else fs.rmSync(prepared, { recursive: true, force: true });
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
  membership?(action: MembershipAction): Promise<{ result: MembershipResult; afterReply?: () => void }>;
}

function parseOp(line: string, token: string): 'hello' | 'stop' | MembershipAction | null {
  try {
    const request = JSON.parse(line) as { op?: unknown; token?: unknown; action?: unknown; expected_pid?: unknown };
    if (!tokensMatch(request.token, token)) return null;
    if (request.expected_pid !== undefined && request.expected_pid !== process.pid) return null;
    if (request.op === 'membership' && Object.keys(request).sort().join(',') === 'action,op,token') return parseMembershipAction(request.action);
    return request.op === 'hello' || request.op === 'stop' ? request.op : null;
  } catch {
    return null;
  }
}

function serveConnection(socket: net.Socket, identity: string, token: string, handlers: ControlHandlers): void {
  let text = '';
  let handled = false;
  socket.setTimeout(REQUEST_DEADLINE_MS, () => socket.destroy());
  socket.on('error', (err) => handlers.onProblem(`Control connection failed: ${err.message}`));
  socket.on('data', (chunk) => {
    if (handled) return;
    text += chunk.toString('utf8');
    if (text.length > REQUEST_MAX_BYTES) {
      socket.destroy();
      return;
    }
    const newline = text.indexOf('\n');
    if (newline === -1) return;
    handled = true;
    const op = parseOp(text.slice(0, newline), token);
    if (op === null) {
      socket.destroy();
      return;
    }
    const reply: Reply = { data_dir: identity, pid: process.pid, ready: handlers.isReady() };
    if (typeof op === 'object') {
      socket.setTimeout(25_000);
      if (!handlers.membership || !handlers.isReady()) { socket.destroy(); return; }
      void handlers.membership(op).then(({ result, afterReply }) => {
        socket.end(`${JSON.stringify({ ...reply, membership: result })}\n`, () => afterReply?.());
        // A lost local ACK must not leave a confirmed departed bridge serving.
        if (socket.destroyed) afterReply?.();
      }).catch((error: unknown) => {
        socket.end(`${JSON.stringify({ ...reply, error: error instanceof Error ? error.message : 'Membership failed' })}\n`);
      });
      return;
    }
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
