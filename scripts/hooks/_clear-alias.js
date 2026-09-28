// =============================================================================
// /clear continuity (#497) — called by session-start.js, not a hook of its own
// =============================================================================
//
// Claude Code's `/clear` gives the session a new id for its hooks and Bash,
// while its MCP servers (the memesh MCP server, the claude channel host) keep
// the id they were started with. A message meant for the session names one of
// those ids, so memesh needs to know the two are one session.
//
// The one thing both ids share is the `claude` process they run under. So at
// every SessionStart this records which session id that process (its pid AND
// start time — a pid alone can be reused) currently has. On a SessionStart
// with source "clear", the id recorded for the same process before is the
// session's previous id: that pair is written as an alias, new -> previous.
// Nothing is inferred from folders or timing.

import { agentScopeIdRejection, AGENT_SCOPE_ID_MAX_LENGTH } from './_generated/agent-scope-id.js';
import { SKIP_REASONS } from './_generated/capture-liveness.js';

/**
 * Record `sessionId` as the current session of `launcher`, and on /clear link
 * it to the one recorded before. Returns the outcome; the caller records it.
 *
 * The database is opened through `openDb` only after the checks that need
 * none, so a session with nothing to record never waits on a write lock.
 * `openDb` returns null when there is no database file yet.
 *
 * @param {() => import('./_generated/sqlite.js').MemeshDatabase | null} openDb returns a writable database, or null when there is no database file yet
 * @param {{
 *   sessionId: unknown,
 *   source: unknown,
 *   agentType?: unknown,
 *   launcher: { pid: number, start: string } | null,
 *   now?: number,
 * }} input
 * @returns {{ outcome: 'notified' | 'skipped', reason: string }}
 */
export function recordSessionLauncher(openDb, { sessionId, source, agentType, launcher, now = Date.now() }) {
  // A subagent's SessionStart runs under the same `claude` process; letting it
  // overwrite the mapping would make the next /clear link to the subagent.
  if (typeof agentType === 'string' && agentType !== '') {
    return { outcome: 'skipped', reason: SKIP_REASONS.sessionLauncherSubagent };
  }
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id || id.length > AGENT_SCOPE_ID_MAX_LENGTH || agentScopeIdRejection('session_id', id) !== null) {
    return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasInvalidInput };
  }
  if (!launcher) return { outcome: 'skipped', reason: SKIP_REASONS.sessionLauncherNotFound };
  const db = openDb();
  if (!db) return { outcome: 'skipped', reason: SKIP_REASONS.sessionLauncherNoDatabase };
  const tables = db.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'table' AND name IN ('agent_session_aliases', 'agent_session_launchers')
  `).get();
  if (tables?.n !== 2) return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasNoTable };

  return db.transaction(() => {
    const previous = db.prepare(`
      SELECT launcher_start, session_id FROM agent_session_launchers WHERE launcher_pid = ?
    `).get(launcher.pid);
    db.prepare(`
      INSERT INTO agent_session_launchers (launcher_pid, launcher_start, session_id, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(launcher_pid) DO UPDATE SET
        launcher_start = excluded.launcher_start,
        session_id = excluded.session_id,
        updated_at_ms = excluded.updated_at_ms
    `).run(launcher.pid, launcher.start, id, now);

    if (source !== 'clear') return { outcome: 'notified', reason: 'session-launcher: recorded this session for its claude process' };
    if (!previous) return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasNoPrevious };
    if (previous.launcher_start !== launcher.start) return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasPidReused };
    if (previous.session_id === id) return { outcome: 'notified', reason: 'clear-alias: the session id did not change' };
    const written = db.prepare(`
      INSERT OR IGNORE INTO agent_session_aliases (session_id, previous_session_id, created_at_ms)
      VALUES (?, ?, ?)
    `).run(id, previous.session_id, now);
    if (Number(written.changes) === 0) return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasAlreadyLinked };
    return { outcome: 'notified', reason: 'clear-alias: linked the new session id to the previous one' };
  }).immediate();
}
