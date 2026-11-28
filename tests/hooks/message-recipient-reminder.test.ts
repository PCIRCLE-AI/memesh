import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { seedLegacyMessage } from '../helpers/agent-session-fixture.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';

describe('separate whole-message hook replaces legacy principal reminders', () => {
  let dir: string, home: string, graph: string;
  const session = 'session-recipient', other = 'session-other';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-body-')); home = path.join(dir, 'home'); graph = path.join(dir, 'graph.db');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ autoCapture: false, autoUpdate: 'off', updateCheck: false, briefing: 'minimal' }));
    openDatabase(graph);
  });
  afterEach(() => { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
  const seed = (intended: string | null = session, project = 'old-project') => seedLegacyMessage(getDatabase(), { project, sender: 'legacy-sender', recipient: 'legacy-principal', intended_session: intended, idempotency_key: project, content_type: 'text/plain', payload: 'LEGACY_HEAD\nLEGACY_MIDDLE\nLEGACY_TAIL' }).message_id;
  function run(script: string, event: string, id = session, extra: NodeJS.ProcessEnv = {}) {
    const r = spawnSync(process.execPath, [path.resolve('scripts/hooks', script)], { input: JSON.stringify({ hook_event_name: event, session_id: id, cwd: dir, prompt: 'hello', prompt_id: 'synthetic-prompt' }), env: { ...process.env, HOME: home, MEMESH_DIR: dir, MEMESH_DB_PATH: graph, MEMESH_AUTO_CAPTURE: 'false', MEMESH_AUTO_UPDATE: 'off', MEMESH_SKIP_UPDATE_CHECK: '1', MEMESH_HOOK_HOST: 'claude-code', MEMESH_RECIPIENT: 'legacy-principal', CODEX_THREAD_ID: '', ...extra }, encoding: 'utf8', timeout: 15000 });
    expect(r.status, r.stderr).toBe(0); expect(() => process.kill(r.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' })); return r;
  }
  function declared(event: string) {
    const manifest = JSON.parse(fs.readFileSync('hooks/hooks.json', 'utf8'));
    const entries = manifest.hooks[event].flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks);
    expect(entries.filter((entry: { command: string }) => entry.command.endsWith('/scripts/hooks/messages.js'))).toHaveLength(1);
    return path.basename(entries.find((entry: { command: string }) => entry.command.endsWith('/scripts/hooks/messages.js')).command);
  }
  const status = () => {
    const store = new ConversationMessages({ file: path.join(dir, 'messages.db') });
    try { return store.status(); } finally { store.close(); }
  };
  it.each([['SessionStart', 'session-start.js'], ['UserPromptSubmit', 'user-prompt-intent.js']])('%s no longer teaches retired actions; its separately declared message hook emits the full envelope', (event, script) => {
    const id = seed(); const before = getDatabase().prepare('SELECT * FROM agent_messages').all();
    const memoryHook = run(script, event);
    expect(memoryHook.stdout).not.toMatch(/poll|fetch|intake|messaging address|legacy-principal|LEGACY_HEAD/i);
    const messageHook = run(declared(event), event);
    const context = JSON.parse(messageHook.stdout).hookSpecificOutput;
    expect(context.hookEventName).toBe(event); expect(context.additionalContext).toContain('untrusted data');
    expect(JSON.parse(context.additionalContext.trim().split('\n')[1])).toMatchObject({ id, recipient: session, body: 'LEGACY_HEAD\nLEGACY_MIDDLE\nLEGACY_TAIL' });
    expect(status().find(row => row.id === id)?.state).toBe('delivered'); expect(run(declared(event), event).stdout).toBe('');
    const imported = status().find(row => row.id === id)!.events.filter(event => event.event === 'legacy_imported');
    expect(imported).toHaveLength(1);
    expect(JSON.parse(imported[0].detail).source.message).toEqual(before[0]);
    expect(getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_messages'").all()).toEqual([]);
  });
  it('does not announce a fake address or rejected old principal override on no-database exits', () => {
    const empty = path.join(dir, 'empty'); fs.mkdirSync(empty);
    for (const [event, script] of [['SessionStart', 'session-start.js'], ['UserPromptSubmit', 'user-prompt-intent.js']]) {
      const r = run(script, event, session, { MEMESH_DB_PATH: path.join(empty, 'missing.db'), MEMESH_RECIPIENT: '/not/a/conversation' });
      expect(r.stdout).not.toMatch(/messaging address|MEMESH_RECIPIENT ignored|poll|fetch|intake/);
    }
  });
  it('does not let another conversation claim an explicit historical session target', () => {
    const id = seed(); expect(run(declared('SessionStart'), 'SessionStart', other).stdout).toBe('');
    expect(status().find(row => row.id === id)?.state).toBe('legacy_imported');
    expect(run(declared('SessionStart'), 'SessionStart').stdout).toContain('LEGACY_HEAD');
  });
  it('retains principal-only history in its legacy namespace rather than broadcasting it to every session', () => {
    const id = seed(null);
    for (const who of [session, other]) expect(run(declared('UserPromptSubmit'), 'UserPromptSubmit', who).stdout).toBe('');
    expect(status().find(row => row.id === id)).toMatchObject({ body: 'LEGACY_HEAD\nLEGACY_MIDDLE\nLEGACY_TAIL', recipient: expect.stringMatching(/^legacy:/), state: 'legacy_imported' });
  });
  it('preserves distinct global message IDs from different projects without project-specific instructions', () => {
    const a = seed(session, 'project-a'), b = seed(session, 'project-b'); expect(a).not.toBe(b);
    const output = run(declared('SessionStart'), 'SessionStart').stdout;
    expect(output).toContain(a); expect(output).toContain(b); expect(output).not.toMatch(/poll|fetch|intake/);
    expect(status().filter(row => [a, b].includes(row.id) && row.state === 'delivered')).toHaveLength(2);
  });
});
