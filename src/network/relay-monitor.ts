// Whether this machine can use its relay right now. The transport gives no signal
// for this: measured against a relay that was stopped, `online()` stays resolved,
// `addr().relayUrl()` keeps the URL and `watchHomeRelay` keeps reporting the same
// URL. So the state combines what the transport did say with a real request.

import type { BridgeStatus, RelayState } from './bridge-state.js';

export const RELAY_PING_INTERVAL_MS = 15_000;
const RELAY_PING_TIMEOUT_MS = 5_000;

export interface RelaySignals {
  /** The transport reported a home relay at least once. */
  online: boolean;
  /** The startup allowance ran out. */
  deadlinePassed: boolean;
  /** The last ping's result; null before the first one. */
  reachable: boolean | null;
}

export function relayStateOf(signals: RelaySignals): RelayState {
  if (signals.reachable === false) return 'unreachable';
  if (signals.online) return 'online';
  return signals.deadlinePassed ? 'unreachable' : 'connecting';
}

export function relayComplaint(relayUrl: string): string {
  return `The relay ${relayUrl} is not answering.`;
}

/**
 * Move a status to what the signals say. Coming back online also removes this
 * monitor's own complaint, so status does not show "online" beside "not answering";
 * any other error stays until something replaces it. Returns whether state changed.
 */
export function applyRelayState(
  status: Pick<BridgeStatus, 'relay_state' | 'last_error' | 'last_error_at'>,
  signals: RelaySignals,
  relayUrl: string,
): boolean {
  const next = relayStateOf(signals);
  if (next === status.relay_state) return false;
  status.relay_state = next;
  if (next === 'online' && status.last_error === relayComplaint(relayUrl)) {
    status.last_error = null;
    status.last_error_at = null;
  }
  return true;
}

export async function pingRelay(relayUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL('ping', relayUrl), { signal: AbortSignal.timeout(RELAY_PING_TIMEOUT_MS) });
    return response.status === 200;
  } catch {
    return false;
  }
}
