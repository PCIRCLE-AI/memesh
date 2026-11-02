// Starting and stopping the bridge from the CLI side. The bridge is always a
// separate process: however it dies, here it is an error message and an exit code.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  logPath, readStatus, runningBridgePid,
} from './bridge-state.js';
import { ensureNetworkDir } from './identity.js';
import { EXIT_ALREADY_RUNNING, NetworkError, SINGLE_MACHINE_NOTE, childEnv, type NetworkContext } from './types.js';

const START_DEADLINE_MS = 20_000;
const STOP_DEADLINE_MS = 10_000;
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function describeBridgeDeath(code: number | null, signal: NodeJS.Signals | null, lastError?: string | null): string {
  const how = signal ? `crashed with signal ${signal}, which usually means its native file is damaged` : `exited with status ${code}`;
  const why = lastError ? ` Its last error: ${lastError}.` : '';
  return `The network bridge ${how}.${why} To reinstall its files, run: memesh network up --reinstall. ${SINGLE_MACHINE_NOTE}`;
}

interface Exit { code: number | null; signal: NodeJS.Signals | null; error?: Error }

function watchExit(child: ChildProcess): () => Exit | null {
  let exit: Exit | null = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  child.once('error', (error) => { exit = { code: null, signal: null, error }; });
  return () => exit;
}

/** Start the bridge unless one runs. Resolves once it has bound and is accepting. */
export async function startBridge(ctx: NetworkContext): Promise<{ pid: number; started: boolean }> {
  const running = runningBridgePid(ctx.dataDir);
  if (running !== null) return { pid: running, started: false };

  ensureNetworkDir(ctx.dataDir);
  const log = fs.openSync(logPath(ctx.dataDir), 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [ctx.bridgeEntry, 'serve'], {
      detached: true,
      stdio: ['ignore', log, log],
      env: childEnv(ctx),
      windowsHide: true,
    });
  } finally {
    fs.closeSync(log);
  }
  const exited = watchExit(child);

  const giveUpAt = Date.now() + START_DEADLINE_MS;
  while (Date.now() < giveUpAt) {
    const status = readStatus(ctx.dataDir);
    const mine = status?.pid === child.pid;
    if (mine && status?.state === 'running') {
      child.unref();
      return { pid: child.pid as number, started: true };
    }
    const exit = exited();
    if (exit) {
      if (exit.code === EXIT_ALREADY_RUNNING) {
        const winner = runningBridgePid(ctx.dataDir);
        if (winner !== null) return { pid: winner, started: false };
      }
      if (exit.error) throw new NetworkError('bridge_failed', `The network bridge could not start: ${exit.error.message}. ${SINGLE_MACHINE_NOTE}`);
      throw new NetworkError('bridge_failed', describeBridgeDeath(exit.code, exit.signal, mine ? status?.last_error : null));
    }
    await sleep(POLL_MS);
  }
  child.kill('SIGKILL');
  throw new NetworkError('bridge_failed', `The network bridge did not start within ${START_DEADLINE_MS / 1000} s. ${SINGLE_MACHINE_NOTE}`);
}

/** Stop the bridge and wait until it is really gone. */
export async function stopBridge(ctx: NetworkContext): Promise<{ stopped: boolean; pid: number | null }> {
  const pid = runningBridgePid(ctx.dataDir);
  if (pid === null) return { stopped: false, pid: null };
  process.kill(pid, 'SIGTERM');
  const giveUpAt = Date.now() + STOP_DEADLINE_MS;
  while (Date.now() < giveUpAt) {
    if (runningBridgePid(ctx.dataDir) !== pid) return { stopped: true, pid };
    await sleep(POLL_MS);
  }
  process.kill(pid, 'SIGKILL');
  await sleep(POLL_MS);
  return { stopped: true, pid };
}
