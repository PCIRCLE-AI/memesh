// Starting and stopping the bridge from the CLI side. The bridge is always a
// separate process: however it dies, here it is an error message and an exit code.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  bridgeHolder, identifyProcess, logPath, lockPath, readLockPid, readStatus, writeStatus,
} from './bridge-state.js';
import { ensureNetworkDir } from './identity.js';
import {
  EXIT_ALREADY_RUNNING, EXIT_LOCK_UNCONFIRMED, NetworkError, SINGLE_MACHINE_NOTE, childEnv, type NetworkContext,
} from './types.js';

const START_DEADLINE_MS = 20_000;
const STOP_DEADLINE_MS = 10_000;
const KILL_DEADLINE_MS = 3_000;
const POLL_MS = 100;
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGABRT']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The way a network child died. It only blames the native file for signals a damaged file can cause. */
export function describeChildDeath(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal === null) return `exited with status ${code}`;
  return CRASH_SIGNALS.has(signal)
    ? `crashed with signal ${signal}, which usually means its native file is damaged`
    : `was stopped by signal ${signal}`;
}

function describeBridgeDeath(code: number | null, signal: NodeJS.Signals | null, lastError: string | null): string {
  const why = lastError ? ` Its last error: ${lastError}.` : '';
  return `The network bridge ${describeChildDeath(code, signal)}.${why} To reinstall its files, run: memesh network up --reinstall. ${SINGLE_MACHINE_NOTE}`;
}

function unconfirmed(pid: number): NetworkError {
  return new NetworkError(
    'bridge_unconfirmed',
    `Process ${pid} holds the network bridge lock, and MeMesh could not confirm whether it is this data folder's bridge. Nothing was started or stopped. If it is not a bridge, remove ${pid} from the lock by stopping that process yourself.`,
  );
}

interface Exit { code: number | null; signal: NodeJS.Signals | null; error?: Error }

function spawnBridge(ctx: NetworkContext): { child: ChildProcess; exited: () => Exit | null } {
  ensureNetworkDir(ctx.dataDir);
  const log = fs.openSync(logPath(ctx.dataDir), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [ctx.bridgeEntry, 'serve', ctx.dataDir], {
      detached: true,
      stdio: ['ignore', log, log],
      env: childEnv(ctx),
      windowsHide: true,
    });
    let exit: Exit | null = null;
    child.once('exit', (code, signal) => { exit = { code, signal }; });
    child.once('error', (error) => { exit = { code: null, signal: null, error }; });
    return { child, exited: () => exit };
  } finally {
    fs.closeSync(log);
  }
}

/**
 * Resolves once this data dir's bridge has bound and is accepting, whoever started
 * it. Another starter's bridge that is still starting is waited for: a caller that
 * goes on to hand out a link needs it answering, not merely alive.
 */
export async function startBridge(ctx: NetworkContext): Promise<{ pid: number; started: boolean }> {
  const giveUpAt = Date.now() + START_DEADLINE_MS;
  let mine: ReturnType<typeof spawnBridge> | null = null;
  for (;;) {
    const holder = bridgeHolder(ctx.dataDir);
    if (holder.kind === 'unknown') {
      mine?.child.kill('SIGKILL');
      throw unconfirmed(holder.pid);
    }
    const status = readStatus(ctx.dataDir);
    if (holder.kind === 'bridge' && status?.pid === holder.pid && status.state === 'running') {
      mine?.child.unref();
      return { pid: holder.pid, started: mine?.child.pid === holder.pid };
    }

    const exit = mine?.exited();
    if (exit && mine) {
      if (exit.error) throw new NetworkError('bridge_failed', `The network bridge could not start: ${exit.error.message}. ${SINGLE_MACHINE_NOTE}`);
      if (exit.code === EXIT_LOCK_UNCONFIRMED) throw unconfirmed(readLockPid(ctx.dataDir) ?? 0);
      if (exit.code !== EXIT_ALREADY_RUNNING) {
        throw new NetworkError('bridge_failed', describeBridgeDeath(exit.code, exit.signal, status?.pid === mine.child.pid ? status?.last_error ?? null : null));
      }
      mine = null; // Lost to another starter: follow that one.
    }
    if (holder.kind === 'none' && !mine) mine = spawnBridge(ctx);

    if (Date.now() >= giveUpAt) {
      mine?.child.kill('SIGKILL');
      throw new NetworkError('bridge_failed', `The network bridge did not start within ${START_DEADLINE_MS / 1000} s. ${SINGLE_MACHINE_NOTE}`);
    }
    await sleep(POLL_MS);
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    // It exited between the check and the signal, which is what was wanted.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

async function waitUntilGone(pid: number, dataDir: string, ms: number): Promise<boolean> {
  const giveUpAt = Date.now() + ms;
  while (Date.now() < giveUpAt) {
    if (identifyProcess(pid, dataDir) === 'not-bridge') return true;
    await sleep(POLL_MS);
  }
  return identifyProcess(pid, dataDir) === 'not-bridge';
}

/**
 * Stop this data dir's bridge and confirm it is gone. Signals only a process it has
 * identified. The cleanup after death is done here too: a forced kill, and every
 * kill on Windows, skips the bridge's own handler.
 */
export async function stopBridge(ctx: NetworkContext): Promise<{ stopped: boolean; pid: number | null; forced: boolean }> {
  const holder = bridgeHolder(ctx.dataDir);
  if (holder.kind === 'none') return { stopped: false, pid: null, forced: false };
  if (holder.kind === 'unknown') throw unconfirmed(holder.pid);

  const { pid } = holder;
  sendSignal(pid, 'SIGTERM');
  let forced = false;
  if (!(await waitUntilGone(pid, ctx.dataDir, STOP_DEADLINE_MS))) {
    forced = true;
    sendSignal(pid, 'SIGKILL');
    if (!(await waitUntilGone(pid, ctx.dataDir, KILL_DEADLINE_MS))) {
      throw new NetworkError('bridge_failed', `The network bridge (pid ${pid}) did not exit after being killed. It is still holding its lock.`);
    }
  }
  if (readLockPid(ctx.dataDir) === pid) fs.rmSync(lockPath(ctx.dataDir), { force: true });
  const status = readStatus(ctx.dataDir);
  if (status?.pid === pid && status.state !== 'stopped') {
    const now = new Date().toISOString();
    writeStatus(ctx.dataDir, {
      ...status,
      state: 'stopped',
      updated_at: now,
      ...(forced ? { last_error: 'The bridge did not stop when asked and was killed.', last_error_at: now } : {}),
    });
  }
  return { stopped: true, pid, forced };
}
