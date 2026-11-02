// What the bridge leaves on disk: its pid lock and its status file. Shared by the
// bridge (which writes) and the CLI (which reads and signals).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { networkDir } from './types.js';

export type RelayState = 'off' | 'connecting' | 'online' | 'unreachable';

export interface BridgeStatus {
  pid: number;
  started_at: string;
  updated_at: string;
  state: 'starting' | 'running' | 'stopped' | 'failed';
  relay_state: RelayState;
  last_error: string | null;
  last_error_at: string | null;
  direct_addresses: string[];
  joins_accepted: number;
  joins_refused: number;
  non_member_refused: number;
  member_stub_served: number;
}

export function statusPath(dataDir: string): string {
  return path.join(networkDir(dataDir), 'bridge-status.json');
}

export function lockPath(dataDir: string): string {
  return path.join(networkDir(dataDir), 'bridge.pid');
}

export function logPath(dataDir: string): string {
  return path.join(networkDir(dataDir), 'bridge.log');
}

/** Atomic, so a reader sees a whole status or the previous one. */
export function writeStatus(dataDir: string, status: BridgeStatus): void {
  const file = statusPath(dataDir);
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readStatus(dataDir: string): BridgeStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8')) as BridgeStatus;
  } catch {
    return null;
  }
}

/**
 * Is `pid` a running bridge? A pid from an old lock file can belong to anything
 * by now, and `down` signals this pid, so where `ps` exists its command line has
 * to say so too. Windows has no `ps`: there only liveness is checked.
 */
export function isBridgeProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    return /bridge\.js serve/.test(command);
  } catch (err) {
    // ps exits 1 when the process vanished between the two checks.
    return (err as { status?: number }).status === undefined;
  }
}

export function readLockPid(dataDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(lockPath(dataDir), 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The running bridge's pid, or null. A lock left by a dead process does not count. */
export function runningBridgePid(dataDir: string): number | null {
  const pid = readLockPid(dataDir);
  return pid !== null && isBridgeProcess(pid) ? pid : null;
}

/**
 * Take the lock with O_EXCL, clearing one left by a dead process. Two starters
 * can both clear the same stale lock and the later unlink can remove the
 * earlier one's fresh lock, so the winner is decided by re-reading after a beat.
 * Returns false when another live bridge holds it.
 */
export async function acquireLock(dataDir: string): Promise<boolean> {
  const file = lockPath(dataDir);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (runningBridgePid(dataDir) !== null) return false;
      fs.rmSync(file, { force: true });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return readLockPid(dataDir) === process.pid;
  }
  return false;
}

export function releaseLock(dataDir: string): void {
  if (readLockPid(dataDir) === process.pid) fs.rmSync(lockPath(dataDir), { force: true });
}
