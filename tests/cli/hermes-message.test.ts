import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationMessages, renderConversationMessage, type ConversationMessage } from '../../src/core/conversation-messages.js';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';

const cli = path.resolve('dist/transports/cli/cli.js');
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-message-'));
  env = buildIsolatedSuiteEnv(process.env, { runtimeHome: home });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(args: string[], input: object) {
  return spawnSync(process.execPath, [cli, ...args], { env, input: JSON.stringify(input), encoding: 'utf8', timeout: 15_000 });
}
const messageFile = () => path.join(home, '.memesh', 'messages.db');

it('binds all four message actions to the Hermes SDK session and rejects a foreign read', () => {
  const discover = run(['hermes', 'message', '--session', 'hermes-sdk'], { action: 'discover' });
  expect(discover.status, discover.stderr).toBe(0);
  expect(JSON.parse(discover.stdout).conversations).toContainEqual(expect.objectContaining({ address: 'hermes-sdk', host: 'hermes' }));

  const store = new ConversationMessages({ file: messageFile() });
  let sent: ConversationMessage;
  try {
    store.register({ id: 'other-sdk', host: 'codex', machine: store.machine, pid: process.pid, wake: {} });
    sent = store.send('other-sdk', { recipient: 'hermes-sdk', kind: 'task', body: 'pending Hermes inbox body' }).message;
    store.register({ id: 'foreign-sdk', host: 'codex', machine: store.machine, pid: process.pid, wake: {} });
    store.send('foreign-sdk', { recipient: 'other-sdk', kind: 'task', body: 'foreign status must stay private' });
    const registration = store.discover().find(row => row.id === 'hermes-sdk')!;
    expect(registration.pid).toBe(process.pid);
    expect(registration.host).toBe('hermes');
  } finally { store.close(); }

  const status = run(['hermes', 'message', '--session', 'hermes-sdk'], { action: 'status', message_id: sent!.id });
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout).messages[0]).toMatchObject({ id: sent!.id, state: 'queued' });
  const foreign = run(['hermes', 'message', '--session', 'foreign-sdk'], { action: 'read', message_id: sent!.id });
  expect(foreign.status).toBe(1);
  const read = run(['hermes', 'message', '--session', 'hermes-sdk'], { action: 'read', message_id: sent!.id });
  expect(read.status, read.stderr).toBe(0);
  expect(JSON.parse(read.stdout).message.body).toBe('pending Hermes inbox body');
  const reply = run(['hermes', 'message', '--session', 'hermes-sdk'], {
    action: 'send', recipient: 'other-sdk', kind: 'result', body: 'actual Hermes reply', reply_to: sent!.id,
  });
  expect(reply.status, reply.stderr).toBe(0);
  expect(JSON.parse(reply.stdout)).toMatchObject({ state: expect.stringMatching(/queued|pushed/) });
  const scoped = run(['hermes', 'message', '--session', 'hermes-sdk'], { action: 'status' });
  expect(scoped.status, scoped.stderr).toBe(0);
  expect(JSON.stringify(JSON.parse(scoped.stdout))).not.toContain('foreign status must stay private');
  const identityField = run(['hermes', 'message', '--session', 'hermes-sdk'], { action: 'discover', sender: 'spoofed' });
  expect(identityField.status).toBe(1);
  // The limit includes both machine names, whose length varies on CI runners.
  const envelope = { ...sent!, sender: 'hermes-sdk', sender_host: 'hermes', recipient: 'other-sdk', recipient_host: 'codex', body: '', body_bytes: 7_600 };
  const body = 'x'.repeat(8_000 - Buffer.byteLength(renderConversationMessage(envelope)));
  const bounded = run(['hermes', 'message', '--session', 'hermes-sdk'], { action: 'send', recipient: 'other-sdk', kind: 'task', body });
  expect(bounded.status, bounded.stderr).toBe(0);
  const readback = new ConversationMessages({ file: messageFile() });
  try {
    const message = readback.status('hermes-sdk', JSON.parse(bounded.stdout).message_id)[0];
    expect(Buffer.byteLength(renderConversationMessage(message))).toBe(8_000);
  } finally { readback.close(); }
  const overflow = run(['hermes', 'message', '--session', 'hermes-sdk'], {
    action: 'send', recipient: 'other-sdk', kind: 'task', body: body + 'x',
  });
  expect(overflow.status).toBe(1);
  expect(overflow.stderr).toContain('message_too_large');
});

it('keeps a queued inbox message pending across prompt prefetch and does not create messages.db for memory-only callers', () => {
  const before = fs.readdirSync(home);
  const legacy = run(['hermes', 'prompt-context', '--session', 'memory-only'], { prompt: 'nothing here' });
  expect(legacy.status, legacy.stderr).toBe(0);
  expect(JSON.parse(legacy.stdout)).toEqual({ text: '', ids: [] });
  expect(fs.readdirSync(home)).toEqual(before);

  const store = new ConversationMessages({ file: messageFile() });
  try {
    store.register({ id: 'sender', host: 'codex', machine: store.machine, pid: process.pid, wake: {} });
    store.register({ id: 'receiver', host: 'hermes', machine: store.machine, pid: process.pid, wake: {} });
    store.send('sender', { recipient: 'receiver', kind: 'task', body: 'repeat until I am read' });
  } finally { store.close(); }
  const first = run(['hermes', 'prompt-context', '--session', 'receiver'], { prompt: 'none', messages: true });
  const second = run(['hermes', 'prompt-context', '--session', 'receiver'], { prompt: 'none', messages: true });
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout).messages).toContain('repeat until I am read');
  expect(JSON.parse(second.stdout).messages).toContain('repeat until I am read');
  env.MEMESH_AUTO_CAPTURE = 'false';
  const capture = run(['hermes', 'capture-turn', '--session', 'receiver'], { user: 'prompt', assistant: 'answer' });
  expect(capture.status, capture.stderr).toBe(0);
  expect(JSON.parse(capture.stdout)).toMatchObject({ outcome: 'skipped' });
  const whileCaptureOff = run(['hermes', 'prompt-context', '--session', 'receiver'], { prompt: 'none', messages: true });
  expect(JSON.parse(whileCaptureOff.stdout).messages).toContain('repeat until I am read');
});

it('preserves memory recall when inbox registration fails and recovers on the next prompt', () => {
  const saved = run(['hermes', 'capture-turn', '--session', 'writer'], {
    user: 'Jasper orange routing prefix: persistent fact',
    assistant: 'Jasper orange routing prefix: exact-detail-Q7',
  });
  expect(saved.status, saved.stderr).toBe(0);
  // A corrupt inbox is also deterministic on Windows and under root; the graph remains readable.
  fs.writeFileSync(messageFile(), 'invalid SQLite inbox');
  const degraded = run(['hermes', 'prompt-context', '--session', 'reader'], {
    prompt: 'Jasper orange routing prefix', messages: true,
  });
  expect(degraded.status, degraded.stderr).toBe(0);
  expect(JSON.parse(degraded.stdout)).toMatchObject({
    text: expect.stringContaining('exact-detail-Q7'), messages: '', messages_error: expect.any(String),
  });
  fs.unlinkSync(messageFile());
  const recovered = run(['hermes', 'prompt-context', '--session', 'reader'], {
    prompt: 'Jasper orange routing prefix', messages: true,
  });
  expect(recovered.status, recovered.stderr).toBe(0);
  const context = JSON.parse(recovered.stdout);
  expect(context.text).toContain('exact-detail-Q7');
  expect(context).not.toHaveProperty('messages_error');
});
