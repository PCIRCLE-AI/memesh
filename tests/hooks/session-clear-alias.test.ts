// `/clear` keeps launcher aliases and ordinary prompt capture scoped to the session.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { installLegacyMessageSchema } from '../helpers/agent-session-fixture.js';
import { SKIP_REASONS } from '../../src/core/capture-liveness.js';
import { removeTempDir } from '../helpers/temp-dir.js';

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

  posixOnly('a startup that cannot write its mapping (write lock held) records an error naming the launcher write', async () => {
    // As right after an upgrade, while the MCP server migrates: another
    // process holds the write lock past the hook's 2s busy_timeout. Held for
    // 6s and then released, so the rest of session-start (which has its own
    // writes) is not what this test measures.
    const locked = path.join(tmp, 'locked');
    const holder = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec('BEGIN IMMEDIATE');
      require('fs').writeFileSync(${JSON.stringify(locked)}, '');
      setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 6000);
    `], { stdio: 'ignore' });
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    const waitUntil = Date.now() + 10_000;
    while (!fs.existsSync(locked) && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(locked), 'fixture: the lock holder never took the lock').toBe(true);
    try {
      underOneClaude([{ source: 'startup', session_id: OLD }]);
    } finally {
      await exited;
    }

    const records = fs.readFileSync(path.join(tmp, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { hook: string; outcome: string; reason?: string })
      .filter((record) => record.hook === 'session-start');
    expect(records.filter((record) => record.outcome === 'error').map((record) => record.reason))
      .toEqual([expect.stringMatching(/^session-launcher: /)]);
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

    it('records every link through more than nine /clears', () => {
      const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      recordSessionLauncher(() => getDatabase(), { sessionId: ids[0], source: 'startup', launcher });
      for (const id of ids.slice(1)) recordSessionLauncher(() => getDatabase(), { sessionId: id, source: 'clear', launcher });

      expect(aliases()).toHaveLength(11);
      expect(aliases()).toEqual(ids.slice(1).map((id, index) => ({ session_id: id, previous_session_id: ids[index] })));
    });

    posixOnly('records a first startup with no database file yet under its own reason', () => {
      closeDatabase();
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      try {
        underOneClaude([{ source: 'startup', session_id: OLD }]);
      } finally {
        openDatabase(dbPath);
      }
      expect(reasons()).toContain(SKIP_REASONS.sessionLauncherNoDatabase);
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

  describe('prompt capture after /clear', () => {

    const prompt = (sessionId: string) => spawnSync('node', [path.resolve('scripts/hooks/user-prompt-intent.js')], {
      input: JSON.stringify({ prompt: 'hello there', session_id: sessionId, cwd }),
      env: { ...process.env, HOME: tmp, MEMESH_DB_PATH: dbPath, MEMESH_RECIPIENT: 'claude-implementer' },
      encoding: 'utf8',
      timeout: 15000,
    });

    const cleared = () => underOneClaude([{ source: 'startup', session_id: OLD }, { source: 'clear', session_id: NEW }]);

    posixOnly('captures ordinary prompts after clear without reviving legacy reminders or consuming the aliased inbox', async () => {
      cleared();
      const db = getDatabase();
      installLegacyMessageSchema(db);
      db.prepare('INSERT INTO agent_messages(message_id,project,sender,recipient,content_type,privacy,payload_json,provenance_json) VALUES (?,?,?,?,?,?,?,?)')
        .run('alias-message', 'team-room', 'legacy-fixture', 'claude-implementer', 'text/plain', 'local', JSON.stringify('legacy fixture'), '{}');
      db.prepare('INSERT INTO agent_message_deliveries(delivery_id,message_id,project,recipient,intended_session) VALUES (?,?,?,?,?)')
        .run('alias-delivery', 'alias-message', 'team-room', 'claude-implementer', OLD);

      const before = db.prepare('SELECT * FROM agent_message_deliveries ORDER BY delivery_id').all();
      for (const session of [NEW, OTHER]) {
        const result = prompt(session);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toMatch(/message waiting|claude-implementer|\bpoll\b|\bfetch\b|\bintake\b/);
        const captured = db.prepare(`SELECT e.id, o.content FROM entities e
          JOIN observations o ON o.entity_id=e.id
          WHERE e.type='conversation' AND EXISTS
            (SELECT 1 FROM tags t WHERE t.entity_id=e.id AND t.tag=?)`).all(`session:${session}`) as Array<{ id: number; content: string }>;
        expect(captured).toHaveLength(1);
        expect(captured[0]!.content).toBe('hello there');
        expect(Buffer.from(captured[0]!.content)).toEqual(Buffer.from('hello there'));
        const tags = db.prepare('SELECT tag FROM tags WHERE entity_id=?').all(captured[0]!.id).map(row => row.tag);
        expect(tags).toContain('role:user');
        expect(tags).not.toContain(`session:${session === NEW ? OTHER : NEW}`);
      }
      // These are legacy alias guarantees, not new messages.js clear routing.
      expect(aliases()).toEqual([{ session_id: NEW, previous_session_id: OLD }]);
      expect(db.prepare('SELECT * FROM agent_message_deliveries ORDER BY delivery_id').all()).toEqual(before);
    });






  });
});
