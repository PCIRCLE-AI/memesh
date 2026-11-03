// What the bridge shows on disk for `network status`. Written only by the process
// holding the control socket, so a process that lost the race cannot overwrite it.

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
