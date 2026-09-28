/**
 * #497 and `/clear`: Claude Code gives the session a new id for its hooks and
 * Bash, while its MCP servers (the memesh MCP server, the claude channel host)
 * keep the id they were started with. A message meant for the session must
 * still reach it, and still be intakeable, under either id.
 *
 * SessionEnd (reason "clear", the OLD id) and SessionStart (source "clear",
 * the NEW id) each leave a marker; whichever runs second pairs them and
 * writes the alias NEW -> OLD. Their order is not documented, so both orders
 * are tested.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { sessionAliasChain, unreadDeliveryCount, unreadMessageRefsFor } from '../../src/core/agent-message-inbox.js';
import { SKIP_REASONS } from '../../src/core/capture-liveness.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';

const require = createRequire(import.meta.url);
// Plain JS helpers with no type declarations.
const clearAlias = require('../../scripts/hooks/_clear-alias.js') as {
  CLEAR_ALIAS_WINDOW_MS: number;
  recordClearSide: (db: unknown, input: { side: 'end' | 'start'; sessionId: string; cwd: string; now?: number }) =>
    { outcome: string; reason: string };
};
const { MemeshDatabase } = require('../../scripts/hooks/_generated/sqlite.js') as {
  MemeshDatabase: new (file: string) => { exec(sql: string): void; close(): void };
};

const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEWER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('Feature: #497 /clear keeps one session one session', () => {
  let tmp: string;
  let dbPath: string;
  let cwd: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-clear-alias-'));
    dbPath = path.join(tmp, 'graph.db');
    cwd = path.join(tmp, 'work');
    fs.mkdirSync(cwd);
    openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    removeTempDir(tmp);
  });

  function run(input: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
    const result = spawnSync('node', [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ cwd, ...input }),
      env: {
        ...process.env, HOME: tmp, MEMESH_DB_PATH: dbPath, MEMESH_HOOK_HOST: 'claude-code',
        MEMESH_RECIPIENT: undefined, ...env,
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status, `session-start exited ${result.status}\nstderr:\n${result.stderr}`).toBe(0);
    return result;
  }
  const end = (sessionId: string, env?: Record<string, string | undefined>) =>
    run({ hook_event_name: 'SessionEnd', reason: 'clear', session_id: sessionId }, env);
  const start = (sessionId: string, env?: Record<string, string | undefined>) =>
    run({ hook_event_name: 'SessionStart', source: 'clear', session_id: sessionId }, env);

  const aliases = () => getDatabase().prepare(
    'SELECT session_id, previous_session_id FROM agent_session_aliases ORDER BY created_at_ms, session_id',
  ).all();
  const markers = () => getDatabase().prepare('SELECT COUNT(*) AS n FROM agent_session_clear_markers').get();
  const outcomes = () => fs.readFileSync(path.join(tmp, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { hook: string; outcome: string; reason?: string })
    .filter((record) => record.hook === 'session-start');

  it('SessionEnd then SessionStart: aliases the new id to the old one, and consumes both markers', () => {
    const endResult = end(OLD);
    expect(endResult.stdout).toBe('');
    start(NEW);

    // Size pin: the empty-alias assertions below mean "nothing linked", not
    // "nothing can be linked".
    expect(aliases()).toHaveLength(1);
    expect(aliases()).toEqual([{ session_id: NEW, previous_session_id: OLD }]);
    expect(markers()).toEqual({ n: 0 });
  });

  it('SessionStart then SessionEnd: the same alias', () => {
    start(NEW);
    end(OLD);

    expect(aliases()).toEqual([{ session_id: NEW, previous_session_id: OLD }]);
    expect(markers()).toEqual({ n: 0 });
  });

  it('two sessions clearing in the same directory: no alias, and the ambiguity is recorded', () => {
    end(OLD);
    end(OTHER);
    start(NEW);

    expect(aliases()).toEqual([]);
    expect(outcomes().map((record) => record.reason)).toContain(SKIP_REASONS.clearAliasAmbiguous);
  });

  it('ignores a marker older than the window', () => {
    getDatabase().prepare(`
      INSERT INTO agent_session_clear_markers (side, session_id, cwd, created_at_ms) VALUES ('end', ?, ?, ?)
    `).run(OLD, fs.realpathSync(cwd), Date.now() - clearAlias.CLEAR_ALIAS_WINDOW_MS - 1000);

    start(NEW);

    expect(aliases()).toEqual([]);
    expect(outcomes().map((record) => record.reason)).toContain(SKIP_REASONS.clearAliasWaiting);
  });

  it('two successive /clears chain: the newest id reaches both earlier ones', () => {
    end(OLD);
    start(NEW);
    end(NEW);
    start(NEWER);

    expect(aliases()).toEqual([
      { session_id: NEW, previous_session_id: OLD },
      { session_id: NEWER, previous_session_id: NEW },
    ]);
    expect([...sessionAliasChain(getDatabase(), NEWER)].sort()).toEqual([OLD, NEW, NEWER].sort());
    expect([...sessionAliasChain(getDatabase(), OLD)].sort()).toEqual([OLD, NEW, NEWER].sort());
  });

  it('records a skip, and writes nothing, when not running under Claude Code', () => {
    end(OLD, { MEMESH_HOOK_HOST: 'codex' });

    expect(markers()).toEqual({ n: 0 });
    expect(outcomes().map((record) => record.reason)).toContain(SKIP_REASONS.notClaudeCodeHost);
  });

  it('records a skip when the database has no alias tables (not migrated)', () => {
    const raw = new MemeshDatabase(path.join(tmp, 'unmigrated.db'));
    try {
      expect(clearAlias.recordClearSide(raw, { side: 'end', sessionId: OLD, cwd })).toEqual({
        outcome: 'skipped', reason: SKIP_REASONS.clearAliasNoTable,
      });
    } finally {
      raw.close();
    }
  });

  describe('after /clear, a message meant for the session', () => {
    async function sendIntended(session: string, key: string) {
      return executeAgentMessageAction(getDatabase(), {
        action: 'send', project: 'team-room', sender: 'codex-lead', recipient: 'claude-implementer',
        intended_session: session, idempotency_key: key, payload: 'for the session', content_type: 'text/plain',
      }, { transport: 'mcp', sourceHost: 'test-host' }) as Promise<{ message_id: string }>;
    }
    const prompt = (sessionId: string) => spawnSync('node', [path.resolve('scripts/hooks/user-prompt-intent.js')], {
      input: JSON.stringify({ prompt: 'hello there', session_id: sessionId, cwd }),
      env: { ...process.env, HOME: tmp, MEMESH_DB_PATH: dbPath, MEMESH_RECIPIENT: 'claude-implementer' },
      encoding: 'utf8',
      timeout: 15000,
    });
    const intake = (messageId: string, hostSession: string, key: string) => executeAgentMessageAction(getDatabase(), {
      action: 'intake', project: 'team-room', recipient: 'claude-implementer', message_id: messageId,
      intake_state: 'ingested', idempotency_key: key,
    }, { transport: 'mcp', sourceHost: 'claude-code', hostSession });

    it('reminds the session under its new id, and not another session', async () => {
      end(OLD);
      start(NEW);
      await sendIntended(OLD, 'k-old');

      expect(prompt(NEW).stdout).toContain('1 message waiting for \\"claude-implementer\\"');
      expect(prompt(OTHER).stdout).not.toContain('message waiting');
    });

    it('counts it as waiting under either id in core too (briefing, CLI), and not for another session', async () => {
      end(OLD);
      start(NEW);
      await sendIntended(OLD, 'k-core');
      const db = getDatabase();

      expect(unreadMessageRefsFor(db, 'claude-implementer', NEW)).toHaveLength(1);
      expect(unreadDeliveryCount(db, 'team-room', 'claude-implementer', NEW)).toBe(1);
      expect(unreadMessageRefsFor(db, 'claude-implementer', OTHER)).toHaveLength(0);
    });

    it('accepts intake from the MCP server holding the old id and from the CLI holding the new one', async () => {
      end(OLD);
      start(NEW);
      const forNew = await sendIntended(NEW, 'k-new');
      const forOld = await sendIntended(OLD, 'k-old-2');

      await expect(intake(forNew.message_id, OLD, 'i-1')).resolves.toMatchObject({ receipt_kind: 'intake' });
      await expect(intake(forOld.message_id, NEW, 'i-2')).resolves.toMatchObject({ receipt_kind: 'intake' });
      await expect(intake((await sendIntended(OLD, 'k-old-3')).message_id, OTHER, 'i-3'))
        .rejects.toMatchObject({ code: 'intended_for_other_session' });
    });

    it('treats the new id as the same session for a session-targeted delivery to the old id', async () => {
      // The channel host restarted and registered under the new id.
      registerAgentSession('team-room', 'claude-implementer', { sessionId: OLD, adapterKind: 'claude-channel' });
      registerAgentSession('team-room', 'claude-implementer', { sessionId: NEW, adapterKind: 'claude-channel' });
      end(OLD);
      start(NEW);
      const sent = await executeAgentMessageAction(getDatabase(), {
        action: 'send', project: 'team-room', sender: 'codex-lead', recipient: OLD, target_kind: 'session',
        idempotency_key: 'k-session', payload: 'x', content_type: 'text/plain',
      }, { transport: 'mcp', sourceHost: 'test-host' }, { sendRouterRequest: async () => ({ delivered: false }) })
        .catch(() => undefined);
      expect(sent).toBeUndefined(); // refused natively, stored durably
      const row = getDatabase().prepare(
        "SELECT message_id FROM agent_message_deliveries WHERE recipient = ? AND target_kind = 'session'",
      ).get(OLD) as { message_id: string };

      await expect(executeAgentMessageAction(getDatabase(), {
        action: 'intake', project: 'team-room', recipient: OLD, message_id: row.message_id,
        intake_state: 'ingested', idempotency_key: 'i-session',
      }, { transport: 'cli', sourceHost: 'cli', hostSession: NEW })).resolves.toMatchObject({ receipt_kind: 'intake' });
    });
  });
});
