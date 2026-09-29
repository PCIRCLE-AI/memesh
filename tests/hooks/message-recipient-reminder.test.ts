import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { buildHint } from '../../scripts/hooks/user-prompt-intent.js';
import { getProjectName } from '../../src/core/paths.js';
import { resolveMessageRecipient } from '../../scripts/hooks/_shared.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { registerAgentSession, sendSessionTargetedMessage } from '../helpers/agent-session-fixture.js';

// A Claude Code session that was not started with the channel flag has no
// identity a sender can address, so nothing ever told it a message was
// waiting. `MEMESH_RECIPIENT` is the session saying who it is; both hooks then
// name the messages waiting for exactly that recipient, and only that one.
describe('Feature: a session that declares MEMESH_RECIPIENT is told when a message is waiting', () => {
  let tmp: string;
  let dbPath: string;
  let home: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-recipient-'));
    dbPath = path.join(tmp, 'graph.db');
    home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    removeTempDir(tmp);
  });

  async function send(recipient: string, project = 'team-room', key = `k-${recipient}-${project}`) {
    const sent = await executeAgentMessageAction(getDatabase(), {
      action: 'send', project, sender: 'codex-reviewer', recipient,
      idempotency_key: key, payload: { text: 'review is done' }, content_type: 'application/json',
    }, { transport: 'mcp', sourceHost: 'test-host' }) as { message_id: string };
    return sent.message_id;
  }

  function run(script: string, input: object, env: Record<string, string | undefined>) {
    const result = spawnSync('node', [path.resolve('scripts/hooks', script)], {
      input: JSON.stringify(input),
      env: { ...process.env, HOME: home, MEMESH_DB_PATH: dbPath, MEMESH_RECIPIENT: undefined, ...env },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status, `${script} exited ${result.status}\nstderr:\n${result.stderr}`).toBe(0);
    return result;
  }

  const prompt = (env: Record<string, string | undefined> = {}, text = 'hello there') =>
    run('user-prompt-intent.js', { prompt: text, session_id: 's-1', cwd: tmp }, env);

  const context = (stdout: string): string =>
    (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

  // The outcome ledger sits beside the database (MEMESH_DB_PATH's directory).
  const ledgerText = (): string => fs.readFileSync(path.join(tmp, 'hook-outcomes.jsonl'), 'utf8');
  const ledger = (hook: string) =>
    ledgerText().trim().split('\n')
      .map((line) => JSON.parse(line) as { hook: string; outcome: string; reason?: string })
      .filter((record) => record.hook === hook);

  it('tells the session at its next prompt, naming the project to poll with', async () => {
    await send('claude-implementer');

    const result = prompt({ MEMESH_RECIPIENT: 'claude-implementer' });

    expect(context(result.stdout)).toContain('1 message waiting for "claude-implementer" in project "team-room"');
    expect(context(result.stdout)).toContain('poll the message tool');
    // A readable inbox leaves exactly one record and no error.
    expect(ledger('user-prompt-intent').map((record) => record.outcome)).toEqual(['notified']);
  });

  it('says nothing when the session has not declared who it is', async () => {
    await send('claude-implementer');

    expect(prompt().stdout).toBe('');
  });

  it('never reveals a message addressed to someone else', async () => {
    await send('gemini-reviewer');

    expect(prompt({ MEMESH_RECIPIENT: 'claude-implementer' }).stdout).toBe('');
  });

  it('SessionStart never reveals a message addressed to someone else', async () => {
    await send('gemini-reviewer');

    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, {
      MEMESH_RECIPIENT: 'claude-implementer',
    });

    expect(start.stdout).not.toContain('gemini-reviewer');
    expect(start.stdout).not.toContain('message waiting');
  });

  it('keeps reminding after a fetch, says which action ends it, and stops once intake is recorded', async () => {
    const messageId = await send('claude-implementer');
    const scope = { project: 'team-room', recipient: 'claude-implementer', message_id: messageId };
    await executeAgentMessageAction(getDatabase(), { action: 'fetch', ...scope }, { transport: 'mcp', sourceHost: 'test-host' });

    const afterFetch = context(prompt({ MEMESH_RECIPIENT: 'claude-implementer' }).stdout);
    expect(afterFetch).toContain('1 message waiting');
    expect(afterFetch).toContain('only intake ends this line');

    await executeAgentMessageAction(getDatabase(), {
      action: 'intake', ...scope, intake_state: 'fetched', idempotency_key: 'intake-1',
    }, { transport: 'mcp', sourceHost: 'test-host' });

    expect(prompt({ MEMESH_RECIPIENT: 'claude-implementer' }).stdout).toBe('');
  });

  it('accepts any id the message tool accepts, including one with a newline', async () => {
    await send('line\nbreak');

    const text = context(prompt({ MEMESH_RECIPIENT: 'line\nbreak' }).stdout);

    expect(text).toContain('1 message waiting for "line\\nbreak"');
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('finds the message whichever project name the sender chose', async () => {
    await send('claude-implementer', 'team-room');
    await send('claude-implementer', 'some-other-room');

    const text = context(prompt({ MEMESH_RECIPIENT: 'claude-implementer' }).stdout);

    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).toContain('in project "team-room"');
    expect(text).toContain('in project "some-other-room"');
  });

  it('ignores an id that cannot be a recipient, and says so on stderr', async () => {
    await send('claude-implementer');

    const result = prompt({ MEMESH_RECIPIENT: 'x'.repeat(201) });

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MEMESH_RECIPIENT ignored');
  });

  it('rejects a filesystem-path recipient the same way the message tool does, with a record and stderr', async () => {
    await send('claude-implementer');

    const result = prompt({ MEMESH_RECIPIENT: '/Users/x' });

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MEMESH_RECIPIENT ignored');
    expect(result.stderr).toContain('filesystem path');
    expect(ledger('user-prompt-intent')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'notified', reason: expect.stringContaining('filesystem path') }),
      ]),
    );
  });

  it('rejects a filesystem-path recipient at SessionStart even with no database yet', () => {
    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, {
      MEMESH_RECIPIENT: '/Users/x',
      MEMESH_DB_PATH: path.join(tmp, 'no-such-graph.db'),
    });

    expect(start.stderr).toContain('MEMESH_RECIPIENT ignored');
    expect(start.stderr).toContain('filesystem path');
    expect(ledger('session-start')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'notified', reason: expect.stringContaining('filesystem path') }),
      ]),
    );
    // A hook that exits 0 hides its stderr from the user and the model —
    // the rejection must also reach the JSON the model actually receives.
    expect(context(start.stdout)).toContain('MEMESH_RECIPIENT ignored');
    expect(context(start.stdout)).toContain('filesystem path');
  });

  // Same requirement on the ordinary has-database path, and on the
  // user-visible systemMessage, not just additionalContext.
  it('rejects a filesystem-path recipient at SessionStart with a database present, visibly on both channels', () => {
    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, {
      MEMESH_RECIPIENT: '/Users/x',
    });

    const payload = JSON.parse(start.stdout) as { systemMessage: string; hookSpecificOutput?: { additionalContext: string } };
    expect(payload.systemMessage).toContain('MEMESH_RECIPIENT ignored');
    expect(payload.systemMessage).toContain('filesystem path');
    expect(payload.hookSpecificOutput?.additionalContext).toContain('MEMESH_RECIPIENT ignored');
  });

  it('still reminds when autoCapture is off, and does not send the remember hint then', async () => {
    await send('claude-implementer');
    fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify({ autoCapture: false }));

    const result = prompt({ MEMESH_RECIPIENT: 'claude-implementer' }, 'remember this preference');

    const text = context(result.stdout);
    expect(text).toContain('1 message waiting for "claude-implementer"');
    expect(text).not.toContain(buildHint());
  });

  it('says so on stderr and in the ledger when the inbox cannot be read, and still lets the prompt and the session start through', async () => {
    await send('claude-implementer');
    getDatabase().exec('ALTER TABLE agent_message_receipts RENAME TO agent_message_receipts_gone');

    const promptRun = prompt({ MEMESH_RECIPIENT: 'claude-implementer' });
    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, { MEMESH_RECIPIENT: 'claude-implementer' });

    expect(promptRun.stdout).toBe('');
    expect(promptRun.stderr).toContain('could not check for waiting messages');
    expect(start.stderr).toContain('could not check for waiting messages');

    // Without a record of its own, the prompt's `skipped` line reads as "nothing
    // was waiting". The failure is its own `error`, a label and not the message.
    expect(ledger('user-prompt-intent')).toEqual([
      expect.objectContaining({ outcome: 'error', reason: expect.stringMatching(/^inbox: uncaught \w+$/) }),
      expect.objectContaining({ outcome: 'skipped' }),
    ]);
    expect(ledger('session-start').filter((record) => record.outcome === 'error')).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/^inbox: uncaught \w+$/) }),
    ]);
    expect(ledgerText()).not.toContain('agent_message_receipts');
  });

  // The other way the read can fail: the database cannot be opened at all
  // (here the path is a directory). That is the helper's own catch, not the
  // query's: a file that opens but holds no database only fails at the query.
  it('records the same error when the database cannot be opened at all', () => {
    const unopenable = path.join(tmp, 'db-is-a-directory');
    fs.mkdirSync(unopenable);

    const promptRun = prompt({ MEMESH_RECIPIENT: 'claude-implementer', MEMESH_DB_PATH: unopenable });

    expect(promptRun.stdout).toBe('');
    expect(promptRun.stderr).toContain('could not check for waiting messages');
    expect(ledger('user-prompt-intent')).toEqual([
      expect.objectContaining({ outcome: 'error', reason: expect.stringMatching(/^inbox: uncaught \w+$/) }),
      expect.objectContaining({ outcome: 'skipped' }),
    ]);
  });

  it('SessionStart names the waiting message too, with nothing else remembered', async () => {
    await send('claude-implementer');
    const startInput = { cwd: tmp, session_id: 's-1', source: 'startup' };

    const declared = run('session-start.js', startInput, { MEMESH_RECIPIENT: 'claude-implementer' });
    const anonymous = run('session-start.js', startInput, {});

    expect(context(declared.stdout)).toContain('1 message waiting for "claude-implementer" in project "team-room"');
    expect(anonymous.stdout).not.toContain('message waiting');
  });

  it('#497: reminds only the session a message is meant for, at the prompt and at SessionStart', async () => {
    const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: 'team-room', sender: 'codex-lead', recipient: 'claude-implementer',
      intended_session: sessionA, idempotency_key: 'k-intended',
      payload: { text: 'for A' }, content_type: 'application/json',
    }, { transport: 'mcp', sourceHost: 'test-host' });
    const env = { MEMESH_RECIPIENT: 'claude-implementer' };

    const promptA = run('user-prompt-intent.js', { prompt: 'hello there', session_id: sessionA, cwd: tmp }, env);
    expect(context(promptA.stdout)).toContain('1 message waiting for "claude-implementer"');
    const promptB = run('user-prompt-intent.js', { prompt: 'hello there', session_id: sessionB, cwd: tmp }, env);
    expect(promptB.stdout).not.toContain('message waiting');

    const startA = run('session-start.js', { cwd: tmp, session_id: sessionA, source: 'startup' }, env);
    expect(context(startA.stdout)).toContain('1 message waiting for "claude-implementer"');
    const startB = run('session-start.js', { cwd: tmp, session_id: sessionB, source: 'startup' }, env);
    expect(startB.stdout).not.toContain('message waiting');
  });

  it('#497: trusts neither id when CODEX_THREAD_ID and the payload session_id differ — counts only unassigned messages, and records it', async () => {
    const thread = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: 'team-room', sender: 'codex-lead', recipient: 'claude-implementer',
      intended_session: thread, idempotency_key: 'k-mismatch-intended',
      payload: { text: 'for the thread' }, content_type: 'application/json',
    }, { transport: 'mcp', sourceHost: 'test-host' });
    await send('claude-implementer', 'team-room', 'k-mismatch-plain');
    const env = { MEMESH_RECIPIENT: 'claude-implementer', CODEX_THREAD_ID: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };

    const result = run('user-prompt-intent.js', { prompt: 'hello there', session_id: thread, cwd: tmp }, env);

    // Only the plain message: the one meant for `thread` needs a trusted id.
    expect(context(result.stdout)).toContain('1 message waiting for "claude-implementer"');
    expect(ledger('user-prompt-intent').map((record) => record.reason ?? ''))
      .toEqual(expect.arrayContaining([expect.stringContaining('session_id_mismatch')]));
  });

  it('hints at SessionStart when the declared recipient has never been seen in any project', () => {
    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, {
      MEMESH_RECIPIENT: 'typo-nobody',
    });

    expect(context(start.stdout)).toContain('"typo-nobody"');
    expect(context(start.stdout)).toContain('never been seen in any project');
    expect(ledger('session-start')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'notified', reason: expect.stringContaining('never seen') }),
      ]),
    );
  });

  it('stays quiet at SessionStart once the declared recipient has been seen, even with an empty inbox', async () => {
    const messageId = await send('claude-implementer');
    await executeAgentMessageAction(getDatabase(), {
      action: 'intake', project: 'team-room', recipient: 'claude-implementer', message_id: messageId,
      intake_state: 'fetched', idempotency_key: 'intake-quiet',
    }, { transport: 'mcp', sourceHost: 'test-host' });

    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, {
      MEMESH_RECIPIENT: 'claude-implementer',
    });

    expect(start.stdout).not.toContain('never been seen');
    // Proves this ran the inbox/recipient-seen check rather than skipping it
    // via an early return (no database, or no entities table) or a silent
    // failure: neither reason appears, and nothing recorded an error.
    expect(ledger('session-start').some((record) =>
      record.reason?.includes('no database yet') || record.reason?.includes('no entities table'))).toBe(false);
    expect(ledger('session-start').some((record) => record.outcome === 'error')).toBe(false);
  });

  // The messaging tables not existing yet is the ONE expected
  // shape of "cannot answer"; it must stay quiet and record no error, unlike
  // any other failure (see the next test).
  it('shows no hint at SessionStart when the messaging tables do not exist yet, and records no error', () => {
    getDatabase().exec('ALTER TABLE agent_principals RENAME TO agent_principals_gone');
    getDatabase().exec('ALTER TABLE agent_message_deliveries RENAME TO agent_message_deliveries_gone');
    getDatabase().exec('ALTER TABLE agent_session_instances RENAME TO agent_session_instances_gone');

    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, {
      MEMESH_RECIPIENT: 'nobody-yet',
    });

    expect(start.stdout).not.toContain('never been seen');
    expect(ledger('session-start').some((record) =>
      record.outcome === 'error' && record.reason?.startsWith('recipient-seen:'))).toBe(false);
  });

  // The hint is shown only for `everSeen === false`; an unanswerable lookup
  // (undefined) must not show it.
  it('records an error, and shows no hint, when the recipient-seen lookup fails for a reason other than missing tables', () => {
    getDatabase().exec('ALTER TABLE agent_principals RENAME COLUMN principal_id TO principal_id_gone');

    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, {
      MEMESH_RECIPIENT: 'nobody-yet',
    });

    expect(start.stdout).not.toContain('never been seen');
    expect(ledger('session-start')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'error', reason: expect.stringContaining('recipient-seen:') }),
      ]),
    );
  });

  it('never hints on UserPromptSubmit — the hint is SessionStart-only', () => {
    const result = prompt({ MEMESH_RECIPIENT: 'typo-nobody' });

    expect(result.stdout).toBe('');
  });

  // the owner-private hosts/claude.json fallback used when
  // MEMESH_RECIPIENT is unset. `MEMESH_DB_PATH` is set to `dbPath` in every
  // `run()` call above, so the "MeMesh data dir" these hooks resolve is
  // `tmp` itself (dirname of dbPath) — the fallback config lives at
  // `tmp/hosts/claude.json`, no `home/.memesh` involved.
  // POSIX only: the owner-private read needs O_NOFOLLOW and a uid check, and
  // the local host runtime that writes hosts/claude.json refuses Windows.
  describe.skipIf(process.platform === 'win32')('Feature: the owner-private Claude channel config supplies the recipient when MEMESH_RECIPIENT is unset', () => {
    function writeClaudeHostConfig(fields: Record<string, string>) {
      const dir = path.join(tmp, 'hosts');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'claude.json'), JSON.stringify(fields), { mode: 0o600 });
    }

    it('falls back to the config file\'s principal_id, with the Claude Code host guard set', async () => {
      const project = getProjectName(tmp);
      await send('claude-fallback-principal', project);
      writeClaudeHostConfig({ project, principal_id: 'claude-fallback-principal' });

      const result = prompt({ MEMESH_HOOK_HOST: 'claude-code' });

      expect(context(result.stdout)).toContain('1 message waiting for "claude-fallback-principal"');
      expect(context(result.stdout)).toContain(`in project "${project}"`);
    });

    // #474: this used to be "does not fall back when the config file names a
    // different project" — the file's `project` was compared against
    // `getProjectName(cwd)` and refused on any mismatch. That field was
    // always a bare typed label (`memesh agent setup claude --project
    // my-project`), never the `<label>~<32 hex>` id `getProjectName`
    // produces, so the comparison failed for every setup that followed the
    // documented example and the fallback silently never activated. Neither
    // side reads `project` for routing any more (the Claude channel host
    // itself derives its own from cwd), so a stale or absent value in the
    // file must not change whether `principal_id` is trusted.
    it('falls back to the config file\'s principal_id even when it still names an unrelated (stale) project', async () => {
      const project = getProjectName(tmp);
      await send('claude-fallback-principal', project);
      writeClaudeHostConfig({ project: 'some-other-project', principal_id: 'claude-fallback-principal' });

      const result = prompt({ MEMESH_HOOK_HOST: 'claude-code' });

      expect(context(result.stdout)).toContain('1 message waiting for "claude-fallback-principal"');
    });

    it('falls back to the config file\'s principal_id even with no project field at all', async () => {
      const project = getProjectName(tmp);
      await send('claude-fallback-principal', project);
      writeClaudeHostConfig({ principal_id: 'claude-fallback-principal' });

      const result = prompt({ MEMESH_HOOK_HOST: 'claude-code' });

      expect(context(result.stdout)).toContain('1 message waiting for "claude-fallback-principal"');
    });

    it('does not fall back under Codex, even with a matching project and file', async () => {
      const project = getProjectName(tmp);
      await send('claude-fallback-principal', project);
      writeClaudeHostConfig({ project, principal_id: 'claude-fallback-principal' });

      const result = prompt({ MEMESH_HOOK_HOST: 'codex' });

      expect(result.stdout).toBe('');
    });

    it('uses only project and principal_id from the file, and never exposes auth_token', async () => {
      const project = getProjectName(tmp);
      const secret = 'router-secret-should-never-leak-abc123';
      await send('claude-fallback-principal', project);
      writeClaudeHostConfig({ project, principal_id: 'claude-fallback-principal', auth_token: secret });

      const result = prompt({ MEMESH_HOOK_HOST: 'claude-code' });

      expect(context(result.stdout)).toContain('1 message waiting for "claude-fallback-principal"');
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(ledgerText()).not.toContain(secret);
    });

    it('stays quiet and never echoes a malformed file even if it holds a secret-shaped string', () => {
      const secret = 'router-secret-should-never-leak-xyz789';
      const dir = path.join(tmp, 'hosts');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Truncated JSON — the parse fails, and on some engines the parse
      // error message quotes the text it choked on.
      fs.writeFileSync(path.join(dir, 'claude.json'), `{"auth_token":"${secret}","principal_id":`, { mode: 0o600 });

      const result = prompt({ MEMESH_HOOK_HOST: 'claude-code' });

      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(secret);
      expect(ledgerText()).not.toContain(secret);
    });

    // `resolveMessageRecipient` calls path helpers (getMemeshDirFromDbPath)
    // that read `process.env.MEMESH_DB_PATH` directly rather than the `env`
    // parameter — the same "path helpers read process.env directly" rule
    // `openHookDb`'s own doc comment states. A direct unit-test call needs
    // the REAL process.env set, restored in `finally`.
    function withRealDbPathEnv<T>(fn: () => T): T {
      const original = process.env.MEMESH_DB_PATH;
      process.env.MEMESH_DB_PATH = dbPath;
      try {
        return fn();
      } finally {
        if (original === undefined) delete process.env.MEMESH_DB_PATH;
        else process.env.MEMESH_DB_PATH = original;
      }
    }

    it('refuses a path-shaped principal_id from the file, quietly, the same way the message tool would', () => {
      const project = getProjectName(tmp);
      writeClaudeHostConfig({ project, principal_id: '/etc/passwd' });

      // Asserted directly on the resolver, not only on the end-to-end
      // reminder: no legitimate message can ever be addressed to a refused
      // id (the `message` tool applies the same rule), so "no reminder
      // appeared" alone cannot tell a refusal apart from an accepted id with
      // nothing waiting for it.
      const resolved = withRealDbPathEnv(() =>
        resolveMessageRecipient({ MEMESH_HOOK_HOST: 'claude-code' }, undefined));
      expect(resolved).toBeUndefined();

      const result = prompt({ MEMESH_HOOK_HOST: 'claude-code' });
      expect(result.stdout).toBe('');
    });

    it('refuses an over-200-character principal_id from the file, quietly', () => {
      const project = getProjectName(tmp);
      writeClaudeHostConfig({ project, principal_id: 'x'.repeat(201) });

      const resolved = withRealDbPathEnv(() =>
        resolveMessageRecipient({ MEMESH_HOOK_HOST: 'claude-code' }, undefined));
      expect(resolved).toBeUndefined();

      const result = prompt({ MEMESH_HOOK_HOST: 'claude-code' });
      expect(result.stdout).toBe('');
    });

    it('ignores a missing config file exactly like an unset MEMESH_RECIPIENT', () => {
      const result = prompt({ MEMESH_HOOK_HOST: 'claude-code' });

      expect(result.stdout).toBe('');
    });
  });

  // #474 follow-up (cross-host discovery): the Claude fallback above only
  // ever fires under `isClaudeCodeHost`, so an ordinary Codex plugin session
  // with no MEMESH_RECIPIENT never learned its own address, even though the
  // router registers it as a principal (`src/host-runtime/codex-session.ts`).
  // `resolveMessageRecipient`'s Codex fallback recomputes that SAME
  // registration decision from `hosts/codex-session.json`, through the
  // shared leaf `resolveCodexSessionPrincipal` both sides call.
  // POSIX only, same reason as the Claude describe block above (the
  // owner-private config read needs O_NOFOLLOW and a uid check).
  describe.skipIf(process.platform === 'win32')('Feature: an ordinary Codex session learns its own messaging address', () => {
    // Matches `CODEX_THREAD_ID` in both src/core/codex-session-principal.ts
    // and src/host-runtime/codex-session.ts (8-4-4-4-12 hex groups) — an
    // arbitrary id like 's-1' (used elsewhere in this file for Claude, which
    // has no such shape requirement) would be refused as not Codex-shaped.
    const codexSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    function writeCodexSessionConfig(fields: Record<string, string>) {
      const dir = path.join(tmp, 'hosts');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'codex-session.json'), JSON.stringify(fields), { mode: 0o600 });
    }

    it('prints the automatic codex-thread address with no MEMESH_RECIPIENT and no configured session', () => {
      const start = run('session-start.js', { cwd: tmp, session_id: codexSessionId, source: 'startup' }, {
        MEMESH_HOOK_HOST: 'codex',
      });

      expect(context(start.stdout)).toContain(`recipient "codex-thread-${codexSessionId}"`);
      // A fresh, machine-generated thread id has necessarily never been
      // "seen" before — the never-seen/typo hint must not fire for it (it
      // would otherwise fire on EVERY automatic Codex session, forever).
      expect(context(start.stdout)).not.toContain('never been seen');
    });

    it('the reviewer\'s exact repro: isolated HOME, PLUGIN_ROOT only, no MEMESH_HOOK_HOST, no database yet', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-isolated-home-'));
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-isolated-workspace-'));
      try {
        const result = spawnSync(process.execPath, [path.resolve('scripts/hooks', 'session-start.js')], {
          input: JSON.stringify({
            hook_event_name: 'SessionStart', source: 'startup', session_id: codexSessionId, cwd: workspace,
          }),
          env: {
            ...process.env,
            HOME: isolatedHome,
            PLUGIN_ROOT: process.cwd(),
            MEMESH_HOOK_HOST: undefined,
            MEMESH_RECIPIENT: undefined,
            MEMESH_DB_PATH: undefined,
          },
          encoding: 'utf8',
          timeout: 15000,
        });

        expect(result.status, `exited ${result.status}\nstderr:\n${result.stderr}`).toBe(0);
        const payload = JSON.parse(result.stdout) as { systemMessage: string };
        expect(payload.systemMessage).toContain(`recipient "codex-thread-${codexSessionId}"`);
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('prints the configured principal when hosts/codex-session.json names this exact workspace', () => {
      writeCodexSessionConfig({ workspace: fs.realpathSync(tmp), principal_id: 'codex-configured-principal' });

      const start = run('session-start.js', { cwd: tmp, session_id: codexSessionId, source: 'startup' }, {
        MEMESH_HOOK_HOST: 'codex',
      });

      expect(context(start.stdout)).toContain('recipient "codex-configured-principal"');
    });

    // The companion reads host configs up to HOST_CONFIG_MAX_BYTES (64 KiB);
    // the hook must accept the same file, or the address silently disappears.
    it('prints the configured principal for a valid config larger than 16 KiB', () => {
      writeCodexSessionConfig({ workspace: fs.realpathSync(tmp), principal_id: 'codex-configured-principal', note: 'x'.repeat(17_000) });

      const start = run('session-start.js', { cwd: tmp, session_id: codexSessionId, source: 'startup' }, {
        MEMESH_HOOK_HOST: 'codex',
      });

      expect(context(start.stdout)).toContain('recipient "codex-configured-principal"');
    });

    it('states no address for a config over 64 KiB, which the companion also refuses', () => {
      writeCodexSessionConfig({ workspace: fs.realpathSync(tmp), principal_id: 'codex-configured-principal', note: 'x'.repeat(66_000) });

      const start = run('session-start.js', { cwd: tmp, session_id: codexSessionId, source: 'startup' }, {
        MEMESH_HOOK_HOST: 'codex',
      });

      expect(start.stdout).not.toContain('codex-configured-principal');
      expect(start.stdout).not.toContain('MeMesh messaging address');
    });

    it('falls back to the automatic codex-thread address when the configured workspace names a different directory', () => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-other-workspace-'));
      try {
        writeCodexSessionConfig({ workspace: fs.realpathSync(other), principal_id: 'codex-configured-principal' });

        const start = run('session-start.js', { cwd: tmp, session_id: codexSessionId, source: 'startup' }, {
          MEMESH_HOOK_HOST: 'codex',
        });

        expect(context(start.stdout)).toContain(`recipient "codex-thread-${codexSessionId}"`);
        expect(start.stdout).not.toContain('codex-configured-principal');
        expect(context(start.stdout)).not.toContain('never been seen');
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    });

    // A config file that EXISTS but cannot be trusted (bad permissions here;
    // codex-session.ts's own reader also refuses a symlink or oversized file
    // the same way) is not "no config" — over there, `readHostConfigFile`
    // throws and the WHOLE companion registration fails. This must resolve to
    // NO recipient, never a silent promotion to the automatic identity: no
    // Codex principal was ever actually registered in that state.
    it('reports no recipient — not the automatic identity — when the config file exists but cannot be trusted', () => {
      const dir = path.join(tmp, 'hosts');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const configFile = path.join(dir, 'codex-session.json');
      fs.writeFileSync(configFile, JSON.stringify({
        workspace: fs.realpathSync(tmp), principal_id: 'codex-configured-principal',
      }));
      // chmodSync, not a creation `mode`, so this is exact regardless of the
      // process umask — group/world-readable, refused the same way
      // hosts/claude.json's reader refuses one.
      fs.chmodSync(configFile, 0o644);

      const start = run('session-start.js', { cwd: tmp, session_id: codexSessionId, source: 'startup' }, {
        MEMESH_HOOK_HOST: 'codex',
      });

      expect(start.stdout).not.toContain('codex-configured-principal');
      expect(start.stdout).not.toContain(`codex-thread-${codexSessionId}`);
    });

    it('never fires under Claude Code, even with a matching codex-session config and a Codex-shaped session id — Claude behaviour is unchanged', () => {
      writeCodexSessionConfig({ workspace: fs.realpathSync(tmp), principal_id: 'codex-configured-principal' });

      // Uses `codexSessionId` (not the Claude-style 's-1' used elsewhere in
      // this file) on purpose: an id that is ALSO valid Codex-thread-shaped is
      // the strict check that this test guards the host gate specifically,
      // not merely the session-id shape check the Codex tests above share.
      const start = run('session-start.js', { cwd: tmp, session_id: codexSessionId, source: 'startup' }, {
        MEMESH_HOOK_HOST: 'claude-code',
      });

      expect(start.stdout).not.toContain('codex-configured-principal');
      expect(start.stdout).not.toContain('codex-thread-');
    });

    it('confirms the UserPromptSubmit inbox reminder follows the same resolver as the address line', async () => {
      const automaticRecipient = `codex-thread-${codexSessionId}`;
      await send(automaticRecipient, 'team-room');

      const result = run('user-prompt-intent.js', { prompt: 'hello there', session_id: codexSessionId, cwd: tmp }, {
        MEMESH_HOOK_HOST: 'codex',
      });

      expect(context(result.stdout)).toContain(`1 message waiting for "${automaticRecipient}" in project "team-room"`);
    });
  });

  // #490: a `target_kind: "session"` delivery is addressed to the HOST's own
  // session_instance_id, not the principal `MEMESH_RECIPIENT` (or the
  // owner-private fallback) resolves to. Both hooks must widen their lookup
  // to also find a delivery targeted at a session that is LIVE right now and
  // registered under that exact principal.
  describe('Feature: #490 a session-targeted delivery is reminded under its principal, only while live', () => {
    // The router already pushed this delivery into the host (a host_accept
    // row, through the same FK chain the router writes).
    function seedHostAccept(project: string, deliveryId: string, principal: string) {
      const suffix = randomUUID();
      const db = getDatabase();
      db.prepare(`
        INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind)
        VALUES (?, ?, ?, 'test-adapter')
      `).run(project, `session-${suffix}`, principal);
      db.prepare(`
        INSERT INTO agent_session_connections (
          connection_id, project, principal_id, session_instance_id, generation,
          adapter_kind, router_instance_id, lease_expires_at_ms
        ) VALUES (?, ?, ?, ?, 1, 'test-adapter', 'test-router', ?)
      `).run(`connection-${suffix}`, project, principal, `session-${suffix}`, Date.now() + 60_000);
      db.prepare(`
        INSERT INTO agent_dispatch_attempts (
          attempt_id, delivery_id, project, principal_id, session_instance_id,
          connection_id, generation, router_instance_id, attempt_number, result, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 'test-router', 1, 'adapter_returned', CURRENT_TIMESTAMP)
      `).run(`attempt-${suffix}`, deliveryId, project, principal, `session-${suffix}`, `connection-${suffix}`);
      db.prepare(`
        INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json)
        VALUES (?, ?, ?, 'test-adapter', '{}')
      `).run(`host-accept-${suffix}`, `attempt-${suffix}`, deliveryId);
    }

    const codexEnv = { MEMESH_HOOK_HOST: 'codex', MEMESH_RECIPIENT: 'claude-implementer' };

    it('under Codex, does not remind about a delivery the router already pushed into the thread', async () => {
      const sessionId = registerAgentSession('team-room', 'claude-implementer');
      const sent = sendSessionTargetedMessage('team-room', sessionId, 'codex-accepted');
      seedHostAccept('team-room', sent.delivery_id, 'claude-implementer');

      const promptResult = run('user-prompt-intent.js', { prompt: 'hello there', session_id: 's-1', cwd: tmp }, codexEnv);
      expect(promptResult.stdout).not.toContain('message waiting');
      const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, codexEnv);
      expect(start.stdout).not.toContain('message waiting');
    });

    it('under Codex, still reminds about a delivery with no host acceptance', async () => {
      const sessionId = registerAgentSession('team-room', 'claude-implementer');
      sendSessionTargetedMessage('team-room', sessionId, 'codex-not-accepted');

      const promptResult = run('user-prompt-intent.js', { prompt: 'hello there', session_id: 's-1', cwd: tmp }, codexEnv);
      expect(context(promptResult.stdout)).toContain(`1 message waiting for the live session ${JSON.stringify(sessionId)}`);
    });

    it('under Claude Code, still reminds about a delivery even with host acceptance', async () => {
      const sessionId = registerAgentSession('team-room', 'claude-implementer');
      const sent = sendSessionTargetedMessage('team-room', sessionId, 'claude-accepted');
      seedHostAccept('team-room', sent.delivery_id, 'claude-implementer');

      const promptResult = run('user-prompt-intent.js', { prompt: 'hello there', session_id: 's-1', cwd: tmp }, {
        MEMESH_HOOK_HOST: 'claude-code', MEMESH_RECIPIENT: 'claude-implementer',
      });
      expect(context(promptResult.stdout)).toContain(`1 message waiting for the live session ${JSON.stringify(sessionId)}`);
    });

    it('UserPromptSubmit reminds about a session-targeted message for a LIVE session under the declared principal, naming the session and target_kind', async () => {
      const sessionId = registerAgentSession('team-room', 'claude-implementer');
      sendSessionTargetedMessage('team-room', sessionId, 'session-k1');

      const result = run('user-prompt-intent.js', { prompt: 'hello there', session_id: 's-1', cwd: tmp }, {
        MEMESH_HOOK_HOST: 'claude-code',
        MEMESH_RECIPIENT: 'claude-implementer',
      });

      const text = context(result.stdout);
      expect(text).toContain(`1 message waiting for the live session ${JSON.stringify(sessionId)}`);
      expect(text).toContain('target_kind "session"');
      expect(text).toContain(`recipient ${JSON.stringify(sessionId)}`);
    });

    it('SessionStart reminds about the same session-targeted message', async () => {
      const sessionId = registerAgentSession('team-room', 'claude-implementer');
      sendSessionTargetedMessage('team-room', sessionId, 'session-k2');

      const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, {
        MEMESH_HOOK_HOST: 'claude-code',
        MEMESH_RECIPIENT: 'claude-implementer',
      });

      expect(context(start.stdout)).toContain(`1 message waiting for the live session ${JSON.stringify(sessionId)}`);
    });

    it('does NOT remind once that session has disconnected — no nagging about a dead session', async () => {
      const sessionId = registerAgentSession('team-room', 'claude-implementer', { disconnected: true });
      sendSessionTargetedMessage('team-room', sessionId, 'session-k3');

      const result = run('user-prompt-intent.js', { prompt: 'hello there', session_id: 's-1', cwd: tmp }, {
        MEMESH_HOOK_HOST: 'claude-code',
        MEMESH_RECIPIENT: 'claude-implementer',
      });

      expect(result.stdout).toBe('');
    });

    it('does NOT remind about a live session registered under a DIFFERENT principal', async () => {
      const sessionId = registerAgentSession('team-room', 'someone-elses-principal');
      sendSessionTargetedMessage('team-room', sessionId, 'session-k4');

      const result = run('user-prompt-intent.js', { prompt: 'hello there', session_id: 's-1', cwd: tmp }, {
        MEMESH_HOOK_HOST: 'claude-code',
        MEMESH_RECIPIENT: 'claude-implementer',
      });

      expect(result.stdout).toBe('');
    });
  });
});
