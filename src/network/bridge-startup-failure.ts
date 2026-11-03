// The last-resort record for a bridge that failed outside serve()'s own handling,
// so even that leaves `network status` something to show.

import { ensureNetworkDir } from './identity.js';
import { releaseLock, writeStatus } from './bridge-state.js';

export function recordStartupFailure(dataDir: string, message: string): void {
  const now = new Date().toISOString();
  try {
    ensureNetworkDir(dataDir);
    writeStatus(dataDir, {
      pid: process.pid,
      started_at: now,
      updated_at: now,
      state: 'failed',
      relay_state: 'off',
      last_error: message,
      last_error_at: now,
      direct_addresses: [],
      joins_accepted: 0,
      joins_refused: 0,
      non_member_refused: 0,
      member_stub_served: 0,
    });
    releaseLock(dataDir);
  } catch (err) {
    process.stderr.write(`The network bridge failed (${message}) and could not record it: ${(err as Error).message}\n`);
  }
}
