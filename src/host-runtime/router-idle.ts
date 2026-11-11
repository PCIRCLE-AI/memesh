import type { MemeshDatabase } from '../storage/sqlite.js';

/**
 * The router is a background process that host sessions start on demand and that nothing
 * else ever stops. With no host connected and nothing being delivered it only holds the
 * database open, so it ends itself after this long: long enough that a session which
 * restarts or a host that reconnects after a network-style hiccup finds it still there,
 * short enough that a router started by a one-off send or check does not stay behind for days.
 * The next host connection starts a new one.
 */
export const DEFAULT_ROUTER_IDLE_MS = 10 * 60_000;
export const DEFAULT_ROUTER_IDLE_CHECK_MS = 30_000;
const MIN_CHECK_MS = 50;

function parseMs(raw: string | undefined, fallback: number, min: number, name: string, warn: (line: string) => void): number {
  if (raw === undefined || raw === '') return fallback;
  if (/^(0|[1-9][0-9]{0,11})$/.test(raw) && Number(raw) >= min) return Number(raw);
  warn(`MeMesh router: ignoring ${name}=${JSON.stringify(raw)}; using ${fallback}\n`);
  return fallback;
}

/** `MEMESH_ROUTER_IDLE_MS`: milliseconds of idleness before the router exits; `0` keeps it running until it is stopped. */
export function routerIdleSettings(env: NodeJS.ProcessEnv, warn: (line: string) => void = (line) => { try { process.stderr.write(line); } catch { /* stderr gone */ } }) {
  return {
    idleMs: parseMs(env.MEMESH_ROUTER_IDLE_MS, DEFAULT_ROUTER_IDLE_MS, 0, 'MEMESH_ROUTER_IDLE_MS', warn),
    checkMs: parseMs(env.MEMESH_ROUTER_IDLE_CHECK_MS, DEFAULT_ROUTER_IDLE_CHECK_MS, MIN_CHECK_MS, 'MEMESH_ROUTER_IDLE_CHECK_MS', warn),
  };
}

/** A host holds a live lease, or a delivery attempt is being run right now. */
export function routerHasWork(db: MemeshDatabase, nowMs: number): boolean {
  const connected = db.prepare(`
    SELECT 1 FROM agent_session_connections
    WHERE disconnected_at IS NULL AND lease_expires_at_ms > ?
    LIMIT 1
  `).get(nowMs) !== undefined;
  if (connected) return true;
  return db.prepare(`
    SELECT 1 FROM agent_dispatch_attempts
    -- an attempt still 'started' after five minutes was abandoned, not in flight
    WHERE result = 'started' AND created_at > datetime('now', '-5 minutes')
    LIMIT 1
  `).get() !== undefined;
}

/** Where the router leaves the time it last ended itself for idleness, so `memesh doctor` can tell that from a crash. */
export const ROUTER_IDLE_EXIT_KEY = 'router_idle_exit_at';

/** Writes the lifecycle record the router leaves just before it exits for idleness. */
export function recordRouterIdleExit(db: MemeshDatabase, at: Date = new Date()): void {
  db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(ROUTER_IDLE_EXIT_KEY, at.toISOString());
}

/** The ISO time the router last ended itself for idleness, or undefined when it never has (or the table does not exist yet). */
export function readRouterIdleExit(db: MemeshDatabase): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(ROUTER_IDLE_EXIT_KEY) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  } catch (error) {
    if (/no such table: memesh_metadata/.test(error instanceof Error ? error.message : String(error))) return undefined;
    throw error;
  }
}

export interface RouterIdleWatch {
  /** One look at the database; the timer calls this, tests call it directly. */
  check(): void;
  stop(): void;
}

/**
 * Calls `onIdle` once, after the router has had no work for `idleMs` in a row. Pending
 * messages for sessions that are not connected do not count as work: the router cannot
 * deliver them until a host connects, and it delivers them as soon as one does.
 */
export function watchRouterIdle(options: {
  db: MemeshDatabase;
  idleMs: number;
  checkMs: number;
  onIdle: () => void;
  now?: () => number;
}): RouterIdleWatch {
  const now = options.now ?? Date.now;
  let idleSince: number | undefined;
  let fired = false;
  const check = () => {
    if (fired) return;
    const at = now();
    if (routerHasWork(options.db, at)) { idleSince = undefined; return; }
    idleSince ??= at;
    if (at - idleSince >= options.idleMs) { fired = true; options.onIdle(); }
  };
  if (options.idleMs <= 0) return { check: () => undefined, stop: () => undefined };
  const timer = setInterval(check, options.checkMs);
  timer.unref();
  return { check, stop: () => clearInterval(timer) };
}
