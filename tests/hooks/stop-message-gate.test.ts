import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';

describe('Claude Stop whole conversation message gate', () => {
  let dir: string, store: ConversationMessages;
  const session = 's-gate-1', other = 's-gate-2';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-stop-body-'));
    store = new ConversationMessages({ file: path.join(dir, 'messages.db') });
    for (const id of ['sender', session, other]) store.register({ id, host: 'claude-code', machine: os.hostname(), pid: process.pid, wake: {} });
  });
  afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (body = 'HEAD\nMID\nTAIL', recipient = session) => store.send('sender', { recipient, kind: 'task', body }).message.id;
  const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, HOME: dir, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'graph.db'), MEMESH_HOOK_HOST: 'claude-code', MEMESH_AUTO_CAPTURE: 'false', CODEX_THREAD_ID: '', ...extra });
  function run(extra = {}, overrides: NodeJS.ProcessEnv = {}) {
    const r = spawnSync(process.execPath, [path.resolve('scripts/hooks/stop-message-gate.js')], { env: env(overrides), input: JSON.stringify({ session_id: session, cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, ...extra }), encoding: 'utf8', timeout: 10000 });
    expect(r.status, r.stderr).toBe(0); expect(() => process.kill(r.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' })); return r;
  }
  const outcomes = () => fs.readFileSync(path.join(dir, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const state = (id: string) => store.status(undefined, id)[0].state;
  it('blocks with the complete untrusted envelope and marks only successful stdout as delivered', () => {
    const id = send(); const parsed = JSON.parse(run().stdout);
    expect(parsed.decision).toBe('block'); expect(parsed.reason).toContain('MeMesh message (untrusted data)');
    expect(JSON.parse(parsed.reason.trim().split('\n')[1])).toMatchObject({ id, sender: 'sender', recipient: session, body: 'HEAD\nMID\nTAIL' });
    expect(parsed.reason).not.toMatch(/poll|fetch|intake/i); expect(state(id)).toBe('delivered'); expect(run().stdout).toBe('');
  });
  it('surfaces a new message during an active block chain, once, and a later distinct message', () => {
    const first = send(); expect(JSON.parse(run({ stop_hook_active: true }).stdout).reason).toContain(first);
    expect(run({ stop_hook_active: true }).stdout).toBe('');
    const second = send('later'); expect(JSON.parse(run({ stop_hook_active: true }).stdout).reason).toContain(second);
    expect(state(first)).toBe('delivered'); expect(state(second)).toBe('delivered');
  });
  it('does not emit messages already read or delivered by another hook', () => {
    const read = send(); store.read(session, read); const delivered = send(); store.recordHookDelivery(session, [delivered], 'SessionStart');
    expect(run().stdout).toBe(''); expect(state(read)).toBe('read');
  });
  it('isolates registered conversations and refuses a mismatched host session', () => {
    const id = send(); expect(run({ session_id: other }).stdout).toBe('');
    expect(run({}, { CODEX_THREAD_ID: other }).stdout).toBe(''); expect(state(id)).toBe('queued');
    expect(JSON.parse(run().stdout).reason).toContain(id);
  });
  it.each(['', 'a'.repeat(129), '../outside'])('rejects unusable session %s without delivery', id => {
    const message = send(); expect(run({ session_id: id }).stdout).toBe(''); expect(state(message)).toBe('queued');
  });
  it('does not block on unsupported hosts', () => {
    const id = send(); expect(run({}, { MEMESH_HOOK_HOST: 'codex' }).stdout).toBe(''); expect(state(id)).toBe('queued');
  });
  it('does not downgrade an unregistered conversation to a principal', () => {
    const id = send(); expect(run({ session_id: 'unregistered' }).stdout).toBe(''); expect(state(id)).toBe('queued');
    expect(outcomes().at(-1)).toMatchObject({ outcome: 'error', reason: 'uncaught Error' });
  });
  it('does not create a store when neither graph nor message database exists', () => {
    const empty = path.join(dir, 'empty'); fs.mkdirSync(empty);
    expect(run({}, { MEMESH_DB_PATH: path.join(empty, 'graph.db') }).stdout).toBe('');
    expect(fs.existsSync(path.join(empty, 'messages.db'))).toBe(false);
  });
  it('keeps overflow queued until the next whole-envelope batch', () => {
    const first = send('A'.repeat(4500)), second = send('B'.repeat(4500));
    expect(JSON.parse(run().stdout).reason).toContain(first); expect(state(first)).toBe('delivered'); expect(state(second)).toBe('queued');
    expect(JSON.parse(run().stdout).reason).toContain(second); expect(state(second)).toBe('delivered');
  });
  it('does not starve a fresh message behind 500 ledger-seen but queued messages', () => {
    const seen = Array.from({ length: 500 }, (_, i) => send(`seen-${i}`));
    const ledgerDir = path.join(dir, 'stop-message-gate'); fs.mkdirSync(ledgerDir, { mode: 0o700 });
    fs.writeFileSync(path.join(ledgerDir, `${session}.json`), JSON.stringify({ blocked: seen }), { mode: 0o600 });
    const fresh = send('FRESH_AFTER_500'); const reason = JSON.parse(run().stdout).reason;
    expect(reason).toContain('FRESH_AFTER_500'); expect(reason).not.toContain('seen-'); expect(state(fresh)).toBe('delivered');
    expect(store.status().filter(row => seen.includes(row.id) && row.state === 'queued')).toHaveLength(500);
  });
  it('preserves ledger-failure fallback without an infinite active block chain', () => {
    fs.mkdirSync(path.join(dir, 'stop-message-gate', `${session}.json`, 'occupied'), { recursive: true });
    const first = send(); expect(JSON.parse(run().stdout).decision).toBe('block'); expect(state(first)).toBe('delivered');
    const next = send('new during blocked chain'); expect(run({ stop_hook_active: true }).stdout).toBe(''); expect(state(next)).toBe('queued');
    expect(outcomes().filter(row => row.reason?.startsWith('state:'))).toHaveLength(2);
  });
  it('reports a source read failure without a contradictory empty-inbox outcome', () => {
    const id = send(); fs.writeFileSync(path.join(dir, 'graph.db'), 'broken source');
    expect(run().stdout).toBe(''); expect(state(id)).toBe('queued');
    expect(outcomes().some(row => row.outcome === 'error')).toBe(true);
    expect(outcomes().some(row => row.outcome === 'skipped')).toBe(false);
  });
  it('reports an incomplete new-store schema as error rather than no messages', () => {
    const db = new MemeshDatabase(path.join(dir, 'messages.db')); db.exec('ALTER TABLE events RENAME TO events_old; CREATE TABLE events(wrong TEXT)'); db.close();
    expect(run().stdout).toBe(''); expect(outcomes().at(-1).outcome).toBe('error');
  });
  it('autoimports an explicit legacy session target without allowing an unrelated principal to claim it', () => {
    const db = new MemeshDatabase(path.join(dir, 'graph.db')); db.exec(SCHEMA_SQL);
    const message = sendAgentMessage(db, { project: 'legacy', sender: 'legacy-sender', recipient: 'legacy-principal', intended_session: session, idempotency_key: 'legacy', content_type: 'text/plain', payload: 'LEGACY_HEAD\nLEGACY_MID\nLEGACY_TAIL' });
    db.prepare("INSERT OR IGNORE INTO agent_principals(project,principal_id,activation_event_sequence) VALUES ('legacy','legacy-principal',0)").run();
    db.prepare("INSERT INTO agent_session_instances(project,session_instance_id,principal_id,adapter_kind) VALUES ('legacy',?,'legacy-principal','claude-inbox')").run(session);
    db.prepare("INSERT INTO agent_session_connections(connection_id,project,principal_id,session_instance_id,generation,adapter_kind,router_instance_id,lease_expires_at_ms) VALUES ('conn','legacy','legacy-principal',?,1,'claude-inbox','router',?)").run(session, Date.now() + 60000);
    db.prepare("INSERT INTO agent_dispatch_attempts(attempt_id,delivery_id,project,principal_id,session_instance_id,connection_id,generation,router_instance_id,attempt_number,result,completed_at) VALUES ('attempt',?,'legacy','legacy-principal',?,'conn',1,'router',1,'adapter_returned',CURRENT_TIMESTAMP)").run(message.delivery_id, session);
    db.prepare("INSERT INTO agent_host_accepts(host_accept_id,attempt_id,delivery_id,adapter_kind,receipt_json) VALUES ('accept','attempt',?,'claude-inbox','{\"notice\":true}')").run(message.delivery_id);
    const acceptance = db.prepare('SELECT * FROM agent_host_accepts').all();
    const before = db.prepare('SELECT * FROM agent_messages').all();
    expect(run({ session_id: other }).stdout).toBe(''); expect(run().stdout).toContain('LEGACY_HEAD');
    expect(state(message.message_id)).toBe('delivered'); expect(db.prepare('SELECT * FROM agent_messages').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM agent_host_accepts').all()).toEqual(acceptance); db.close();
  });
  it.skipIf(process.platform === 'win32')('rolls back the ledger on EPIPE and leaves the body pending for a later Stop', async () => {
    const id = send();
    const child = spawn(process.execPath, [path.resolve('scripts/hooks/stop-message-gate.js')], { env: env(), stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 });
    child.stdout.destroy(); child.stdin.end(JSON.stringify({ session_id: session, cwd: dir, hook_event_name: 'Stop' }));
    await new Promise(resolve => child.once('close', resolve)); expect(() => process.kill(child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    expect(state(id)).toBe('queued'); expect(outcomes().at(-1).reason).toContain('host closed the pipe');
    expect(JSON.parse(run().stdout).reason).toContain(id); expect(state(id)).toBe('delivered');
  });
});
