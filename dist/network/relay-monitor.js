export const RELAY_PING_INTERVAL_MS = 15_000;
const RELAY_PING_TIMEOUT_MS = 5_000;
export function relayStateOf(signals) {
    if (signals.reachable === false)
        return 'unreachable';
    if (signals.online)
        return 'online';
    return signals.deadlinePassed ? 'unreachable' : 'connecting';
}
export function relayComplaint(relayUrl) {
    return `The relay ${relayUrl} is not answering.`;
}
export function applyRelayState(status, signals, relayUrl) {
    const next = relayStateOf(signals);
    if (next === status.relay_state)
        return false;
    status.relay_state = next;
    if (next === 'online' && status.last_error === relayComplaint(relayUrl)) {
        status.last_error = null;
        status.last_error_at = null;
    }
    return true;
}
export async function pingRelay(relayUrl, fetchImpl = fetch) {
    try {
        const response = await fetchImpl(new URL('ping', relayUrl), { redirect: 'manual', signal: AbortSignal.timeout(RELAY_PING_TIMEOUT_MS) });
        return response.status >= 200 && response.status < 300;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=relay-monitor.js.map