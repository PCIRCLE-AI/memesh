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

export type ProcessIdentity = 'bridge' | 'not-bridge' | 'unknown';

/** The bridge is always started with its data dir last, so its command line says whose it is. */
function isThisBridge(command: string, dataDir: string): boolean {
  return command.replace(/"/g, '').trimEnd().endsWith(`bridge.js serve ${dataDir}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM is someone else's process, and a bridge of this data dir is never that.
    return false;
  }
}

/** Command line from /proc, or null when /proc cannot answer. */
function linuxCommandLine(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').join(' ');
  } catch {
    return null;
  }
}

/**
 * Command line through an external program, or null when it could not say.
 * Anything short of a clean answer (program missing, too slow, non-zero exit) is
 * not evidence about the process, which is what makes "unknown" a separate state.
 */
function commandLineFrom(program: string, args: string[]): string | null {
  try {
    return execFileSync(program, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function commandLineOf(pid: number): string | null {
  if (process.platform === 'linux') {
    const command = linuxCommandLine(pid);
    if (command !== null) return command;
  }
  if (process.platform === 'win32') {
    // Part of every supported Windows. `pid` is a validated integer.
    return commandLineFrom('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ]);
  }
  return commandLineFrom('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
}

/**
 * Is `pid` this data dir's bridge? A pid in an old lock can belong to anything by
 * now and `down` signals it, so a live process counts only when its command line
 * names this data dir. When that cannot be read the answer is "unknown": callers
 * must neither signal it nor take its lock.
 */
export function identifyProcess(pid: number, dataDir: string): ProcessIdentity {
  if (!isProcessAlive(pid)) return 'not-bridge';
  const command = commandLineOf(pid);
  if (command === null) return isProcessAlive(pid) ? 'unknown' : 'not-bridge';
  return isThisBridge(command, dataDir) ? 'bridge' : 'not-bridge';
}

export function readLockPid(dataDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(lockPath(dataDir), 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export type BridgeHolder =
  | { kind: 'none' }
  | { kind: 'bridge'; pid: number }
  | { kind: 'unknown'; pid: number };

/** Who holds the lock. A lock left by a dead process, or by an unrelated one that reused its pid, counts as none. */
export function bridgeHolder(dataDir: string): BridgeHolder {
  const pid = readLockPid(dataDir);
  if (pid === null) return { kind: 'none' };
  const identity = identifyProcess(pid, dataDir);
  if (identity === 'bridge') return { kind: 'bridge', pid };
  return identity === 'unknown' ? { kind: 'unknown', pid } : { kind: 'none' };
}

/**
 * Remove a lock judged stale, but only if it is still that lock. Judging takes
 * time, and another starter may have replaced it meanwhile; moving the file aside
 * is atomic and shows what was actually taken. A fresh lock taken by mistake goes
 * straight back, without overwriting a newer one.
 */
export function removeStaleLock(dataDir: string, stalePid: number | null): boolean {
  const file = lockPath(dataDir);
  const aside = `${file}.stale-${process.pid}`;
  try {
    fs.renameSync(file, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  try {
    const value = Number(fs.readFileSync(aside, 'utf8').trim());
    const taken = Number.isSafeInteger(value) && value > 0 ? value : null;
    if (taken === stalePid) return true;
    try {
      fs.linkSync(aside, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return false;
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

export type LockResult = 'acquired' | 'held' | 'unconfirmed';

/**
 * Take the lock with O_EXCL, clearing one left by a dead process. The re-read after
 * a beat settles two starters that cleared the same stale lock; the bridge's
 * heartbeat also re-reads it for as long as it runs, and exits if it lost.
 */
export async function acquireLock(dataDir: string): Promise<LockResult> {
  const file = lockPath(dataDir);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = readLockPid(dataDir);
      // A lock naming this very process is from an earlier life of the same pid.
      if (pid !== null && pid !== process.pid) {
        const identity = identifyProcess(pid, dataDir);
        if (identity === 'bridge') return 'held';
        if (identity === 'unknown') return 'unconfirmed';
      }
      removeStaleLock(dataDir, pid);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return readLockPid(dataDir) === process.pid ? 'acquired' : 'held';
  }
  return 'held';
}

export function releaseLock(dataDir: string): void {
  if (readLockPid(dataDir) === process.pid) fs.rmSync(lockPath(dataDir), { force: true });
}
