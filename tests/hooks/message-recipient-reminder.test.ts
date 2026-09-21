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

  it('tells the session at its next prompt, naming the project to poll with', async () => {
    await send('claude-implementer');

    const result = prompt({ MEMESH_RECIPIENT: 'claude-implementer' });

    expect(context(result.stdout)).toContain('1 message waiting for "claude-implementer" in project "team-room"');
    expect(context(result.stdout)).toContain('poll the message tool');
  });

  it('says nothing when the session has not declared who it is', async () => {
    await send('claude-implementer');

    expect(prompt().stdout).toBe('');
  });

  it('never reveals a message addressed to someone else', async () => {
    await send('gemini-reviewer');

    expect(prompt({ MEMESH_RECIPIENT: 'claude-implementer' }).stdout).toBe('');
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

  it('still reminds when autoCapture is off, and does not send the remember hint then', async () => {
    await send('claude-implementer');
    fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify({ autoCapture: false }));

    const result = prompt({ MEMESH_RECIPIENT: 'claude-implementer' }, 'remember this preference');

    const text = context(result.stdout);
    expect(text).toContain('1 message waiting for "claude-implementer"');
    expect(text).not.toContain(buildHint());
  });

  it('says so on stderr when the inbox cannot be read, and still lets the prompt and the session start through', async () => {
    await send('claude-implementer');
    getDatabase().exec('ALTER TABLE agent_message_receipts RENAME TO agent_message_receipts_gone');

    const promptRun = prompt({ MEMESH_RECIPIENT: 'claude-implementer' });
    const start = run('session-start.js', { cwd: tmp, session_id: 's-1', source: 'startup' }, { MEMESH_RECIPIENT: 'claude-implementer' });

    expect(promptRun.stdout).toBe('');
    expect(promptRun.stderr).toContain('could not check for waiting messages');
    expect(start.stderr).toContain('could not check for waiting messages');
  });

  it('SessionStart names the waiting message too, with nothing else remembered', async () => {
    await send('claude-implementer');
    const startInput = { cwd: tmp, session_id: 's-1', source: 'startup' };

    const declared = run('session-start.js', startInput, { MEMESH_RECIPIENT: 'claude-implementer' });
    const anonymous = run('session-start.js', startInput, {});

    expect(context(declared.stdout)).toContain('1 message waiting for "claude-implementer" in project "team-room"');
    expect(anonymous.stdout).not.toContain('message waiting');
  });
});
