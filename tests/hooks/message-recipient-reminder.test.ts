import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { buildHint } from '../../scripts/hooks/user-prompt-intent.js';
import { removeTempDir } from '../helpers/temp-dir.js';

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
});
