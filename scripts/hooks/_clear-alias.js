// =============================================================================
// /clear pairing (#497) — called by session-start.js, not a hook of its own
// =============================================================================
//
// Claude Code's `/clear` gives the session a new id for its hooks and Bash,
// while its MCP servers (the memesh MCP server, the claude channel host) keep
// the id they were started with. A message meant for the session names one of
// those ids, so memesh needs to know the two are one session.
//
// No field names the previous session. What does exist: SessionEnd fires with
// reason "clear" and the OLD id, and SessionStart fires with source "clear"
// and the NEW id, both in the same cwd. Their order is not something to rely
// on, so each side leaves a marker, and whichever side arrives second finds
// the other's marker and writes the alias NEW -> OLD. Both steps run in one
// IMMEDIATE transaction, so two hook processes cannot both "arrive first".

import { realpathSync } from 'fs';
import { agentScopeIdRejection, AGENT_SCOPE_ID_MAX_LENGTH } from './_generated/agent-scope-id.js';
import { SKIP_REASONS } from './_generated/capture-liveness.js';

/**
 * How far apart the two sides of one /clear may run. They fire back to back,
 * but each hook process can take up to its hooks.json timeout to get here
 * (SessionStart 10s, SessionEnd 3s), so the window must exceed the largest of
 * them. 15s does, and stays short enough that two unrelated sessions clearing
 * in the same directory rarely overlap — and when they do, nothing is linked
 * (see `recordClearSide`). Markers older than this are deleted.
 */
export const CLEAR_ALIAS_WINDOW_MS = 15_000;

/**
 * Record one side of a /clear and, if the other side is already here, write
 * the alias. Returns the outcome for the caller to record; never throws for
 * an expected condition.
 *
 * - exactly one matching opposite marker: alias written, both markers gone;
 * - none: this side's marker is left for the other side (`clearAliasWaiting`);
 * - more than one (two sessions cleared in this cwd at once): no alias, and
 *   the candidates are consumed too, so a late arrival cannot pair with the
 *   wrong one (`clearAliasAmbiguous`). This side leaves no marker either.
 *
 * @param {import('./_generated/sqlite.js').MemeshDatabase} db a writable database
 * @param {{ side: 'end' | 'start', sessionId: unknown, cwd: unknown, now?: number }} input
 * @returns {{ outcome: 'notified' | 'skipped', reason: string }}
 */
export function recordClearSide(db, { side, sessionId, cwd, now = Date.now() }) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  let dir = '';
  try {
    dir = typeof cwd === 'string' && cwd !== '' ? realpathSync(cwd) : '';
  } catch {
    dir = '';
  }
  if (!id || id.length > AGENT_SCOPE_ID_MAX_LENGTH || agentScopeIdRejection('session_id', id) !== null || !dir) {
    return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasInvalidInput };
  }
  const tables = db.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'table' AND name IN ('agent_session_aliases', 'agent_session_clear_markers')
  `).get();
  if (tables?.n !== 2) return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasNoTable };

  const opposite = side === 'end' ? 'start' : 'end';
  return db.transaction(() => {
    db.prepare('DELETE FROM agent_session_clear_markers WHERE created_at_ms < ?').run(now - CLEAR_ALIAS_WINDOW_MS);
    const candidates = db.prepare(`
      SELECT session_id FROM agent_session_clear_markers
      WHERE side = ? AND cwd = ? AND session_id <> ?
    `).all(opposite, dir, id);
    if (candidates.length === 0) {
      db.prepare(`
        INSERT OR REPLACE INTO agent_session_clear_markers (side, session_id, cwd, created_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(side, id, dir, now);
      return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasWaiting };
    }
    const consume = db.prepare('DELETE FROM agent_session_clear_markers WHERE side = ? AND session_id = ?');
    for (const candidate of candidates) consume.run(opposite, candidate.session_id);
    consume.run(side, id);
    if (candidates.length > 1) return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasAmbiguous };

    const other = candidates[0].session_id;
    const [newId, previousId] = side === 'start' ? [id, other] : [other, id];
    const written = db.prepare(`
      INSERT OR IGNORE INTO agent_session_aliases (session_id, previous_session_id, created_at_ms)
      VALUES (?, ?, ?)
    `).run(newId, previousId, now);
    if (Number(written.changes) === 0) return { outcome: 'skipped', reason: SKIP_REASONS.clearAliasAlreadyLinked };
    return { outcome: 'notified', reason: 'clear-alias: linked the new session id to the previous one' };
  }).immediate();
}
