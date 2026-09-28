/**
 * #497 and `/clear`: Claude Code gives the session a new id for its hooks and
 * Bash, while its MCP servers (the memesh MCP server, the claude channel host)
 * keep the id they were started with. A message meant for the session must
 * still reach it, and still be intakeable, under either id.
 *
 * What links the two ids is the `claude` process both run under: every
 * SessionStart records (launcher pid, launcher start time) -> session id, and
 * a SessionStart with source "clear" links its new id to the one recorded for
 * the same process before. These tests run session-start.js under a real
 * stand-in `claude` process (a node script named `claude`), so the ancestry
 * walk and `ps` are real.
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
const { recordSessionLauncher } = require('../../scripts/hooks/_clear-alias.js') as {
  recordSessionLauncher: (openDb: () => unknown, input: {
    sessionId: unknown; source: unknown; agentType?: unknown; launcher: { pid: number; start: string } | null; now?: number;
  }) => { outcome: string; reason: string };
};
const { resolveClaudeLauncher } = require('../../scripts/hooks/_claude-channel.js') as {
  resolveClaudeLauncher: (ppid: number, runPs: (pid: number) => string, runPsStart: (pid: number) => string) =>
    { pid: number; start: string; command: string } | null;
};
const { MemeshDatabase } = require('../../scripts/hooks/_generated/sqlite.js') as {
  MemeshDatabase: new (file: string) => { close(): void };
};

const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBAGENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// A stand-in for the `claude` CLI: `ps` shows it as `node <dir>/claude ...`,
// which is how the npm shim appears, so the hook's ancestry walk finds it.
// It runs session-start.js once per payload, in order, as its own children.
const FAKE_CLAUDE = `
const { spawnSync } = require('child_process');
const fs = require('fs');
const [hook, payloadsFile, resultsFile] = process.argv.slice(2);
const results = [];
for (const payload of JSON.parse(fs.readFileSync(payloadsFile, 'utf8'))) {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), env: process.env, encoding: 'utf8', timeout: 15000 });
  results.push({ status: r.status, stdout: r.stdout, stderr: r.stderr });
}
fs.writeFileSync(resultsFile, JSON.stringify(results));
`;

// The launcher mapping reads `ps`, which Windows does not have: there the
// ids are not linked (documented), so the process-level cases run on POSIX.
const posixOnly = it.skipIf(process.platform === 'win32');

describe('Feature: #497 /clear keeps one session one session', () => {
  let tmp: string;
  let dbPath: string;
  let cwd: string;
  let fakeClaude: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-clear-alias-'));
    dbPath = path.join(tmp, 'graph.db');
    cwd = path.join(tmp, 'work');
    fs.mkdirSync(cwd);
    fakeClaude = path.join(tmp, 'claude');
    fs.writeFileSync(fakeClaude, FAKE_CLAUDE);
    openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    removeTempDir(tmp);
  });

  const hookEnv = (extra: Record<string, string | undefined> = {}) => ({
    ...process.env, HOME: tmp, MEMESH_DB_PATH: dbPath, MEMESH_HOOK_HOST: 'claude-code', MEMESH_RECIPIENT: undefined,
    ...extra,
  });

  /** One `claude` process running these SessionStarts in order. */
  function underOneClaude(starts: Array<Record<string, unknown>>) {
    const payloads = path.join(tmp, `payloads-${Math.random()}.json`);
    const results = path.join(tmp, `results-${Math.random()}.json`);
    fs.writeFileSync(payloads, JSON.stringify(starts.map((s) => ({ hook_event_name: 'SessionStart', cwd, ...s }))));
    const run = spawnSync(process.execPath, [fakeClaude, path.resolve('scripts/hooks/session-start.js'), payloads, results], {
      env: hookEnv(), encoding: 'utf8', timeout: 60000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(fs.readFileSync(results, 'utf8')) as Array<{ status: number; stderr: string }>;
    for (const r of out) expect(r.status, r.stderr).toBe(0);
    return out;
  }

  const aliases = () => getDatabase().prepare(
    'SELECT session_id, previous_session_id FROM agent_session_aliases ORDER BY created_at_ms, session_id',
  ).all();
  const reasons = () => fs.readFileSync(path.join(tmp, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { hook: string; reason?: string })
    .filter((record) => record.hook === 'session-start')
    .map((record) => record.reason);

  posixOnly('startup then /clear under one claude process: links the new id to the previous one', () => {
    underOneClaude([{ source: 'startup', session_id: OLD }, { source: 'clear', session_id: NEW }]);

    expect(aliases()).toHaveLength(1);
    expect(aliases()).toEqual([{ session_id: NEW, previous_session_id: OLD }]);
  });

  posixOnly('a /clear under a DIFFERENT claude process never links to another process\'s session', () => {
    underOneClaude([{ source: 'startup', session_id: OLD }]);
    underOneClaude([{ source: 'clear', session_id: NEW }]);

    expect(aliases()).toEqual([]);
    expect(reasons()).toContain(SKIP_REASONS.clearAliasNoPrevious);
  });

  posixOnly('a subagent SessionStart does not become the session a later /clear links to', () => {
    underOneClaude([
      { source: 'startup', session_id: OLD },
      { source: 'startup', session_id: SUBAGENT, agent_type: 'Explore' },
      { source: 'clear', session_id: NEW },
    ]);

    // Linked to OLD, not to the subagent's id recorded in between.
    expect(aliases()).toEqual([{ session_id: NEW, previous_session_id: OLD }]);
  });

  posixOnly('records why, and links nothing, when there is no ps to find the claude process', () => {
    const noTools = path.join(tmp, 'empty-bin');
    fs.mkdirSync(noTools);
    const run = spawnSync(process.execPath, [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear', session_id: NEW, cwd }),
      env: hookEnv({ PATH: noTools }), encoding: 'utf8', timeout: 15000,
    });
    expect(run.status, run.stderr).toBe(0);

    expect(aliases()).toEqual([]);
    expect(reasons()).toContain(SKIP_REASONS.sessionLauncherNotFound);
    expect(resolveClaudeLauncher(123, () => { throw new Error('spawn ps ENOENT'); }, () => 'x')).toBeNull();
  });

  describe('the mapping itself (recordSessionLauncher)', () => {
    const launcher = { pid: 4242, start: 'Mon Sep 28 10:00:00 2026' };

    it('does not record a subagent SessionStart as the process\'s session', () => {
      recordSessionLauncher(() => getDatabase(), { sessionId: OLD, source: 'startup', launcher });
      expect(recordSessionLauncher(() => getDatabase(), {
        sessionId: SUBAGENT, source: 'startup', agentType: 'Explore', launcher,
      })).toEqual({ outcome: 'skipped', reason: SKIP_REASONS.sessionLauncherSubagent });
      expect(getDatabase().prepare('SELECT session_id FROM agent_session_launchers WHERE launcher_pid = ?').get(4242))
        .toEqual({ session_id: OLD });
    });

    it('links only on /clear: a startup or resume in the same process just records the new session', () => {
      recordSessionLauncher(() => getDatabase(), { sessionId: OLD, source: 'startup', launcher });
      recordSessionLauncher(() => getDatabase(), { sessionId: NEW, source: 'resume', launcher });

      expect(aliases()).toEqual([]);
      expect(getDatabase().prepare('SELECT session_id FROM agent_session_launchers WHERE launcher_pid = ?').get(4242))
        .toEqual({ session_id: NEW });
    });

    it('does not link across a reused pid (same pid, different start time)', () => {
      recordSessionLauncher(() => getDatabase(), { sessionId: OLD, source: 'startup', launcher });

      expect(recordSessionLauncher(() => getDatabase(), {
        sessionId: NEW, source: 'clear', launcher: { pid: 4242, start: 'Tue Sep 29 09:00:00 2026' },
      })).toEqual({ outcome: 'skipped', reason: SKIP_REASONS.clearAliasPidReused });
      expect(aliases()).toEqual([]);
    });

    it('keeps the spawn-time id reachable through more than nine /clears', () => {
      const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      recordSessionLauncher(() => getDatabase(), { sessionId: ids[0], source: 'startup', launcher });
      for (const id of ids.slice(1)) recordSessionLauncher(() => getDatabase(), { sessionId: id, source: 'clear', launcher });

      expect(aliases()).toHaveLength(11);
      const chain = sessionAliasChain(getDatabase(), ids[11]);
      expect(chain.has(ids[0])).toBe(true);
      expect(chain.size).toBe(12);
      expect(sessionAliasChain(getDatabase(), ids[0]).has(ids[11])).toBe(true);
    });

    it('records a skip when there is no claude process, and when the database has no tables', () => {
      expect(recordSessionLauncher(() => getDatabase(), { sessionId: OLD, source: 'clear', launcher: null }))
        .toEqual({ outcome: 'skipped', reason: SKIP_REASONS.sessionLauncherNotFound });
      const raw = new MemeshDatabase(path.join(tmp, 'unmigrated.db'));
      try {
        expect(recordSessionLauncher(() => raw, { sessionId: OLD, source: 'clear', launcher }))
          .toEqual({ outcome: 'skipped', reason: SKIP_REASONS.clearAliasNoTable });
      } finally {
        raw.close();
      }
    });
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
    const cleared = () => underOneClaude([{ source: 'startup', session_id: OLD }, { source: 'clear', session_id: NEW }]);

    posixOnly('reminds the session under its new id of a message meant for its spawn-time id, and not another session', async () => {
      cleared();
      await sendIntended(OLD, 'k-old');

      expect(prompt(NEW).stdout).toContain('1 message waiting for \\"claude-implementer\\"');
      expect(prompt(OTHER).stdout).not.toContain('message waiting');
    });

    posixOnly('counts it as waiting under either id in core too (briefing, CLI), and not for another session', async () => {
      cleared();
      await sendIntended(OLD, 'k-core');
      const db = getDatabase();

      expect(unreadMessageRefsFor(db, 'claude-implementer', NEW)).toHaveLength(1);
      expect(unreadDeliveryCount(db, 'team-room', 'claude-implementer', NEW)).toBe(1);
      expect(unreadMessageRefsFor(db, 'claude-implementer', OTHER)).toHaveLength(0);
    });

    posixOnly('accepts intake from the MCP server holding the old id and from the CLI holding the new one', async () => {
      cleared();
      const forNew = await sendIntended(NEW, 'k-new');
      const forOld = await sendIntended(OLD, 'k-old-2');

      await expect(intake(forNew.message_id, OLD, 'i-1')).resolves.toMatchObject({ receipt_kind: 'intake' });
      await expect(intake(forOld.message_id, NEW, 'i-2')).resolves.toMatchObject({ receipt_kind: 'intake' });
      await expect(intake((await sendIntended(OLD, 'k-old-3')).message_id, OTHER, 'i-3'))
        .rejects.toMatchObject({ code: 'intended_for_other_session' });
    });

    posixOnly('treats the new id as the same session for a session-targeted delivery to the old id', async () => {
      // The channel host restarted and registered under the new id.
      registerAgentSession('team-room', 'claude-implementer', { sessionId: OLD, adapterKind: 'claude-channel' });
      registerAgentSession('team-room', 'claude-implementer', { sessionId: NEW, adapterKind: 'claude-channel' });
      cleared();
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
