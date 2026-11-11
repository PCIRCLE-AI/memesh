export const DEFAULT_ROUTER_IDLE_MS = 10 * 60_000;
export const DEFAULT_ROUTER_IDLE_CHECK_MS = 30_000;
const MIN_CHECK_MS = 50;
function parseMs(raw, fallback, min, name, warn) {
    if (raw === undefined || raw === '')
        return fallback;
    if (/^(0|[1-9][0-9]{0,11})$/.test(raw) && Number(raw) >= min)
        return Number(raw);
    warn(`MeMesh router: ignoring ${name}=${JSON.stringify(raw)}; using ${fallback}\n`);
    return fallback;
}
export function routerIdleSettings(env, warn = (line) => { try {
    process.stderr.write(line);
}
catch { } }) {
    return {
        idleMs: parseMs(env.MEMESH_ROUTER_IDLE_MS, DEFAULT_ROUTER_IDLE_MS, 0, 'MEMESH_ROUTER_IDLE_MS', warn),
        checkMs: parseMs(env.MEMESH_ROUTER_IDLE_CHECK_MS, DEFAULT_ROUTER_IDLE_CHECK_MS, MIN_CHECK_MS, 'MEMESH_ROUTER_IDLE_CHECK_MS', warn),
    };
}
export function routerHasWork(db, nowMs) {
    const connected = db.prepare(`
    SELECT 1 FROM agent_session_connections
    WHERE disconnected_at IS NULL AND lease_expires_at_ms > ?
    LIMIT 1
  `).get(nowMs) !== undefined;
    if (connected)
        return true;
    return db.prepare(`
    SELECT 1 FROM agent_dispatch_attempts
    -- an attempt still 'started' after five minutes was abandoned, not in flight
    WHERE result = 'started' AND created_at > datetime('now', '-5 minutes')
    LIMIT 1
  `).get() !== undefined;
}
export const ROUTER_IDLE_EXIT_KEY = 'router_idle_exit_at';
export function recordRouterIdleExit(db, at = new Date()) {
    db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(ROUTER_IDLE_EXIT_KEY, at.toISOString());
}
export function readRouterIdleExit(db) {
    try {
        const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(ROUTER_IDLE_EXIT_KEY);
        return typeof row?.value === 'string' ? row.value : undefined;
    }
    catch (error) {
        if (/no such table: memesh_metadata/.test(error instanceof Error ? error.message : String(error)))
            return undefined;
        throw error;
    }
}
export function watchRouterIdle(options) {
    const now = options.now ?? Date.now;
    let idleSince;
    let fired = false;
    const check = () => {
        if (fired)
            return;
        const at = now();
        if (routerHasWork(options.db, at)) {
            idleSince = undefined;
            return;
        }
        idleSince ??= at;
        if (at - idleSince >= options.idleMs) {
            fired = true;
            options.onIdle();
        }
    };
    if (options.idleMs <= 0)
        return { check: () => undefined, stop: () => undefined };
    const timer = setInterval(check, options.checkMs);
    timer.unref();
    return { check, stop: () => clearInterval(timer) };
}
//# sourceMappingURL=router-idle.js.map