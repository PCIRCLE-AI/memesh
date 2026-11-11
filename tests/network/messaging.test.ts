// Cross-machine messages without a transport: addresses, frames, the outbox, what
// a received frame becomes, presence and discover cards, receipts and auto-start.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { formatNetworkAddress, parseNetworkAddress, projectHash } from '../../src/network/address.js';
import { maybeStartNetworkBridge, resetAutoStartForTests } from '../../src/network/auto-start.js';
import {
  NOTICE_SENDER, buildMessageFrame, dueMachines, dueOutgoingFor, enqueueOutgoing, expireOverdue, localPresence, receiveMessage,
  receivePresence, recordAttempt, type Joined,
} from '../../src/network/courier.js';
import {
  FRAME_MAX_BYTES, MESSAGE_FRAME_KEYS, PRESENCE_ENTRY_KEYS, PRESENCE_FRAME_KEYS, encodeFrame, parseFrame, type MessageFrame,
} from '../../src/network/frames.js';
import { ensureIdentity, type Identity } from '../../src/network/identity.js';
import { remoteDiscoverCards, resolveNetworkRecipient } from '../../src/network/outbound.js';
import { addMember, createRoster, signRoster, verifyRoster } from '../../src/network/roster.js';
import { insertConfig, readConfig, signedRosterOf } from '../../src/network/store.js';
import { makeHome, removeTree } from './helpers.js';

const NETWORK_ID = '0123456789abcdef0123456789abcdef';
const PROJECT = 'shared~0123456789abcdef0123456789abcdef';
const context = { transport: 'cli' as const, sourceHost: 'test-host' };

let home: string;
let db: MemeshDatabase;
let self: Identity;
let peer: Identity;

/** This machine joined as ann@alpha, with ben@beta as the other member. */
function join(withPeer = true): Joined {
  const now = new Date().toISOString();
  let roster = createRoster(NETWORK_ID, { machine_id: self.machineId, name: 'alpha', person: 'ann', joined_at: now });
  if (withPeer) roster = addMember(roster, { machine_id: peer.machineId, name: 'beta', person: 'ben', joined_at: now });
  const signed = signRoster(self, roster);
  insertConfig(db, {
    network_id: NETWORK_ID, owner_id: self.machineId, machine_id: self.machineId, machine_name: 'alpha', person: 'ann',
    relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature,
  }, Date.now());
  const config = readConfig(db);
  if (!config) throw new Error('no config');
  return { config, roster: verifyRoster(signedRosterOf(config), config.owner_id, config.network_id) };
}

const send = (recipient: string, payload: string, extra: Record<string, unknown> = {}) => executeAgentMessageAction(db, {
  action: 'send', project: PROJECT, sender: 'alice', recipient, idempotency_key: `k-${payload}`, payload, ...extra,
}, context) as Promise<Record<string, unknown>>;

const inbox = (recipient: string) => db.prepare('SELECT sender, recipient, payload_json, provenance_json, reply_to_message_id FROM agent_messages WHERE recipient = ?').all(recipient) as Array<Record<string, string>>;

beforeEach(() => {
  home = makeHome();
  db = openDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
  self = ensureIdentity(path.join(home, 'self'));
  peer = ensureIdentity(path.join(home, 'peer'));
  resetAutoStartForTests();
});
afterEach(() => {
  closeDatabase();
  removeTree(home);
});

describe('addresses', () => {
  it('split on the last @, then the first /', () => {
    expect(parseNetworkAddress('ann/alice@alpha')).toEqual({ person: 'ann', target: 'alice', machine: 'alpha' });
    expect(parseNetworkAddress('ann/shared-claude-ab12@alpha')).toEqual({ person: 'ann', target: 'shared-claude-ab12', machine: 'alpha' });
    for (const bad of ['alice', 'ann@alpha', '/alice@alpha', 'ann/@alpha', 'ann/a@', 'a b/c@d', 'ann/a/b@alpha', 'ann/a@b@c']) {
      expect(parseNetworkAddress(bad)).toBeNull();
    }
    expect(formatNetworkAddress('ann', 'alice', 'alpha')).toBe('ann/alice@alpha');
  });

  it('a project hash depends on the network and the project, and is not the project', () => {
    const hash = projectHash(NETWORK_ID, PROJECT);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('shared');
    expect(projectHash('f'.repeat(32), PROJECT)).not.toBe(hash);
  });
});

describe('who counts as another machine', () => {
  it('a local principal literally named a/b@c still delivers locally when this machine never joined', async () => {
    const sent = await send('a/b@c', 'hello');
    expect(String(sent.delivery_note)).toMatch(/inbox/);
    expect(inbox('a/b@c')).toHaveLength(1);
    expect(resolveNetworkRecipient(db, 'a/b@c')).toBeNull();
  });

  it('and when joined, as long as no member is called c', async () => {
    join();
    expect(resolveNetworkRecipient(db, 'a/b@c')).toBeNull();
    const sent = await send('a/b@c', 'hello');
    expect(String(sent.delivery_note)).toMatch(/inbox/);
    expect(inbox('a/b@c')).toHaveLength(1);
  });

  it('a network send never asks the local router to deliver it natively; a local send does', async () => {
    join();
    // A stand-in router socket that counts every connection made to it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
    const socketPath = path.join(dir, 'r.sock');
    let connections = 0;
    const server = net.createServer((socket) => { connections++; socket.destroy(); });
    await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
    const before = process.env.MEMESH_ROUTER_SOCKET;
    process.env.MEMESH_ROUTER_SOCKET = socketPath;
    try {
      await send('bob', 'local, so the router is told');
      await vi.waitFor(() => expect(connections).toBeGreaterThan(0), { timeout: 5_000 });
      const afterLocal = connections;
      await send('ben/bob@beta', 'to another machine');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(connections).toBe(afterLocal);
    } finally {
      if (before === undefined) delete process.env.MEMESH_ROUTER_SOCKET;
      else process.env.MEMESH_ROUTER_SOCKET = before;
      await new Promise((resolve) => { server.close(resolve); });
      removeTree(dir);
    }
  });

  it('a local message to such a name, sent before the machine joined, is never forwarded after it joins', async () => {
    await send('ben/bob@beta', 'meant for a local bob');
    // Sent an hour before this machine joined a network that has a machine named beta.
    db.prepare("UPDATE agent_messages SET created_at = datetime('now', '-1 hour')").run();
    const joined = join();
    expect(enqueueOutgoing(db, joined, Date.now())).toBe(0);
    expect(db.prepare('SELECT state FROM agent_network_outbox').all()).toEqual([{ state: 'local' }]);
    expect(dueMachines(db, Date.now())).toEqual([]);
  });

  it('a member machine with the right person is another machine, and the answer says how it goes', async () => {
    join();
    const sent = await send('ben/bob@beta', 'hello');
    expect(sent.delivery_note).toMatch(/goes to machine beta directly.*retried for up to one day/);
  });

  it('a member machine with the wrong person, or this machine, fails with a sentence', async () => {
    join();
    await expect(send('zed/bob@beta', 'x')).rejects.toThrowError(/belongs to "ben".*ben\/bob@beta/);
    await expect(send('ann/bob@alpha', 'y')).rejects.toThrowError(/is this machine/);
    await expect(send('ben/bob@beta', 'z', { target_kind: 'session' })).rejects.toThrowError(/do not apply/);
  });
});

describe('frames', () => {
  const message = (): MessageFrame => ({
    version: 1, kind: 'message', project_hash: 'a'.repeat(64), sender: 'alice', target: 'bob', target_kind: 'principal',
    idempotency_key: 'k', content_type: 'text/plain', payload: 'hi', correlation_id: null, reply_to_origin: null,
    origin_message_id: 'm1', created_at: '2026-11-08T00:00:00Z',
  });

  it('keys are exactly the allowlist, both ways', () => {
    expect(Object.keys(message()).sort()).toEqual([...MESSAGE_FRAME_KEYS].sort());
    expect(parseFrame(encodeFrame(message()))).toEqual(message());
    for (const extra of [{ provenance: {} }, { sender_host: 'mac' }, { work_summary: 'x' }]) {
      expect(() => parseFrame(Buffer.from(JSON.stringify({ ...message(), ...extra })))).toThrowError(/other keys/);
    }
    const { created_at: _drop, ...missing } = message();
    expect(() => parseFrame(Buffer.from(JSON.stringify(missing)))).toThrowError(/other keys/);
    const presence = { version: 1, kind: 'presence', relay: null, addrs: [], entries: [{ project_hash: 'b'.repeat(64), principal: 'p', handle: 'h', host_kind: 'claude', connected: true }] };
    expect(Object.keys(presence).sort()).toEqual([...PRESENCE_FRAME_KEYS].sort());
    expect(Object.keys(presence.entries[0]).sort()).toEqual([...PRESENCE_ENTRY_KEYS].sort());
    expect(parseFrame(Buffer.from(JSON.stringify(presence)))).toEqual(presence);
    expect(() => parseFrame(Buffer.from(JSON.stringify({ ...presence, entries: [{ ...presence.entries[0], work_summary: 'x' }] })))).toThrowError(/wrong shape/);
  });

  it('refuses a sender that is an address, and anything too large', () => {
    expect(() => parseFrame(Buffer.from(JSON.stringify({ ...message(), sender: 'x/y@z' })))).toThrowError(/wrong shape/);
    expect(() => parseFrame(Buffer.alloc(FRAME_MAX_BYTES + 1, 0x20))).toThrowError(/too large/);
    expect(() => parseFrame(Buffer.from(JSON.stringify({ ...message(), payload: 'x'.repeat(70 * 1024) })))).toThrowError(/wrong shape|too large/);
  });
});

describe('the outbox', () => {
  it('takes a member address, leaves a local one alone, and builds the frame from the message row only', async () => {
    const joined = join();
    await send('ben/bob@beta', 'to-beta', { correlation_id: 'c1' });
    await send('a/b@c', 'local');
    expect(enqueueOutgoing(db, joined, Date.now())).toBe(1);
    expect(dueMachines(db, Date.now())).toEqual([peer.machineId]);
    const due = dueOutgoingFor(db, peer.machineId, Date.now());
    expect(due).toHaveLength(1);
    const frame = buildMessageFrame(db, joined, due[0]);
    if (typeof frame === 'string') throw new Error(frame);
    expect(Object.keys(frame).sort()).toEqual([...MESSAGE_FRAME_KEYS].sort());
    expect(frame).toMatchObject({ sender: 'alice', target: 'bob', payload: 'to-beta', correlation_id: 'c1', project_hash: projectHash(NETWORK_ID, PROJECT) });
    expect(JSON.stringify(frame)).not.toContain(PROJECT);
  });

  it('due messages are grouped per machine, each machine\'s kept in the order they were sent', async () => {
    const joined = join();
    const first = await send('ben/bob@beta', 'first');
    const second = await send('ben/bob@beta', 'second');
    const third = await send('ben/bob@beta', 'third');
    enqueueOutgoing(db, joined, Date.now());
    expect(dueMachines(db, Date.now())).toEqual([peer.machineId]);
    expect(dueOutgoingFor(db, peer.machineId, Date.now()).map((entry) => entry.message_id)).toEqual([first.message_id, second.message_id, third.message_id]);
    expect(dueOutgoingFor(db, 'someone-else', Date.now())).toHaveLength(0);
  });

  it('a retry reuses the idempotency key, so the receiver stores one copy', async () => {
    const joined = join();
    await send('ben/bob@beta', 'once');
    enqueueOutgoing(db, joined, Date.now());
    const frame = buildMessageFrame(db, joined, dueOutgoingFor(db, peer.machineId, Date.now())[0]) as MessageFrame;
    const again = buildMessageFrame(db, joined, dueOutgoingFor(db, peer.machineId, Date.now())[0]) as MessageFrame;
    expect(again.idempotency_key).toBe(frame.idempotency_key);
  });

  it('a rejection and an expiry each tell the original sender, once, in one sentence with the codes', async () => {
    const joined = join();
    await send('ben/bob@beta', 'refused');
    await send('ben/bob@beta', 'late');
    enqueueOutgoing(db, joined, Date.now());
    const [first, second] = dueOutgoingFor(db, peer.machineId, Date.now());
    expect(recordAttempt(db, first, { ack: { result: 'rejected', code: 'project_unknown' } }, Date.now())).toBe('rejected');
    db.prepare('UPDATE agent_network_outbox SET expires_at_ms = 1 WHERE delivery_id = ?').run(second.delivery_id);
    expect(expireOverdue(db, Date.now())).toBe(1);
    expect(expireOverdue(db, Date.now())).toBe(0);
    const notices = db.prepare('SELECT payload_json FROM agent_messages WHERE sender = ? AND recipient = ?').all(NOTICE_SENDER, 'alice') as Array<{ payload_json: string }>;
    const texts = notices.map((row) => JSON.parse(row.payload_json) as string).sort();
    expect(texts).toHaveLength(2);
    expect(texts.some((text) => /was refused by beta\. Codes: state=rejected, code=project_unknown\./.test(text))).toBe(true);
    expect(texts.some((text) => /did not take it within one day\. Codes: state=expired/.test(text))).toBe(true);
  });

  it('a failed attempt backs off and stays pending', async () => {
    const joined = join();
    await send('ben/bob@beta', 'retry');
    enqueueOutgoing(db, joined, Date.now());
    const [entry] = dueOutgoingFor(db, peer.machineId, Date.now());
    expect(recordAttempt(db, entry, { failure: 'unreachable' }, Date.now())).toBe('pending');
    expect(dueOutgoingFor(db, peer.machineId, Date.now())).toHaveLength(0);
    expect(dueOutgoingFor(db, peer.machineId, Date.now() + 6_000)).toHaveLength(1);
  });
});

describe('receiving', () => {
  const frameFor = (project: string, extra: Partial<MessageFrame> = {}): MessageFrame => ({
    version: 1, kind: 'message', project_hash: projectHash(NETWORK_ID, project), sender: 'bob', target: 'alice', target_kind: 'principal',
    idempotency_key: 'remote-1', content_type: 'text/plain', payload: 'from beta', correlation_id: null, reply_to_origin: null,
    origin_message_id: 'remote-message-1', created_at: '2026-11-08T00:00:00Z', ...extra,
  });

  it('stores through the message store, sender from the roster, provenance network; a repeat is a duplicate', async () => {
    const joined = join();
    await send('alice', 'local, so this machine knows the project');
    const member = joined.roster.members[1];
    expect(receiveMessage(db, joined, member, frameFor(PROJECT))).toEqual({ result: 'accepted' });
    expect(receiveMessage(db, joined, member, frameFor(PROJECT))).toEqual({ result: 'duplicate' });
    const stored = inbox('alice').filter((row) => row.sender !== 'alice');
    expect(stored).toHaveLength(1);
    expect(stored[0].sender).toBe('ben/bob@beta');
    expect(JSON.parse(stored[0].provenance_json)).toEqual({ via: 'network', from_machine: 'beta', origin_message_id: 'remote-message-1' });
  });

  it('a project this machine does not have is refused project_unknown', () => {
    const joined = join();
    expect(receiveMessage(db, joined, joined.roster.members[1], frameFor('elsewhere~ffff'))).toEqual({ result: 'rejected', code: 'project_unknown' });
  });

  it('replies map both ways', async () => {
    const joined = join();
    const original = await send('ben/bob@beta', 'question');
    const member = joined.roster.members[1];
    // The answer from beta names this machine's message as the one it replies to.
    receiveMessage(db, joined, member, frameFor(PROJECT, { idempotency_key: 'answer', reply_to_origin: String(original.message_id), origin_message_id: 'beta-answer' }));
    const answer = inbox('alice').find((row) => row.sender === 'ben/bob@beta');
    expect(answer?.reply_to_message_id).toBe(original.message_id);
    // A local reply to that answer carries beta's own id back.
    const answerId = (db.prepare('SELECT message_id FROM agent_messages WHERE sender = ?').get('ben/bob@beta') as { message_id: string }).message_id;
    await send('ben/bob@beta', 'thanks', { reply_to: answerId });
    enqueueOutgoing(db, joined, Date.now());
    const frames = dueOutgoingFor(db, peer.machineId, Date.now()).map((entry) => buildMessageFrame(db, joined, entry) as MessageFrame);
    expect(frames.find((frame) => frame.payload === 'thanks')?.reply_to_origin).toBe('beta-answer');
  });
});

describe('presence and discover', () => {
  const live = (project: string, principal: string, session: string): void => {
    db.prepare("INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, ?, 0)").run(project, principal);
    db.prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, ?, ?, 'claude-channel')").run(project, session, principal);
    db.prepare(`INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation, adapter_kind, router_instance_id, lease_expires_at_ms)
      VALUES (?, ?, ?, ?, 1, 'claude-channel', 'r', ?)`).run(`c-${session}`, project, principal, session, Date.now() + 60_000);
  };

  it('presence carries only hash, principal, handle, host kind and connected', () => {
    const joined = join();
    live(PROJECT, 'alice', 'session-abcd');
    const entries = localPresence(db, joined, Date.now());
    expect(entries).toEqual([{ project_hash: projectHash(NETWORK_ID, PROJECT), principal: 'alice', handle: 'shared-claude-abcd', host_kind: 'claude', connected: true }]);
  });

  it('remote cards only for this project, with the full address, remote, and no work summary', async () => {
    const joined = join();
    receivePresence(db, joined.roster.members[1], {
      version: 1, kind: 'presence', relay: null, addrs: ['10.0.0.2:1'], entries: [
        { project_hash: projectHash(NETWORK_ID, PROJECT), principal: 'bob', handle: 'shared-codex-wxyz', host_kind: 'codex', connected: true },
        { project_hash: projectHash(NETWORK_ID, 'other~1'), principal: 'carol', handle: 'other-claude-0000', host_kind: 'claude', connected: true },
      ],
    }, Date.now());
    const cards = remoteDiscoverCards(db, PROJECT);
    expect(cards).toEqual([{
      remote: true, address: 'ben/shared-codex-wxyz@beta', principal_address: 'ben/bob@beta', machine: 'beta', person: 'ben',
      principal_id: 'bob', handle: 'shared-codex-wxyz', host_kind: 'codex', active: true,
    }]);
    // Through discover: appended after the router's cards, and the local card keeps its own summary.
    const local = { session_id: 's', principal_id: 'alice', host_kind: 'claude', handle: 'h', project: PROJECT, model: null, work_summary: 'secret task', active: true };
    const result = await executeAgentMessageAction(db, { action: 'discover', project: PROJECT }, context, {
      sendRouterRequest: async () => ({ cards: [local] }),
    }) as { cards: Array<Record<string, unknown>> };
    expect(result.cards).toHaveLength(2);
    expect(result.cards[1]).not.toHaveProperty('work_summary');
    expect(JSON.stringify(result.cards[1])).not.toContain('secret task');
    // Expired presence is gone.
    expect(remoteDiscoverCards(db, PROJECT, Date.now() + 4 * 60_000)).toEqual([]);
  });

  it('discover never fails because of the network part', async () => {
    join();
    db.exec('DROP TABLE agent_network_presence');
    const result = await executeAgentMessageAction(db, { action: 'discover', project: PROJECT }, context, {
      sendRouterRequest: async () => ({ cards: [] }),
    }) as Record<string, unknown>;
    expect(result.cards).toEqual([]);
    expect(String(result.network_note)).toMatch(/could not be listed/);
  });
});

describe('receipts', () => {
  it('a network message shows a network fact with state, attempts, code, delivered_at and path', async () => {
    const joined = join();
    const sent = await send('ben/bob@beta', 'tracked');
    enqueueOutgoing(db, joined, Date.now());
    const [entry] = dueOutgoingFor(db, peer.machineId, Date.now());
    recordAttempt(db, entry, { ack: { result: 'accepted' }, path: 'direct' }, Date.now());
    const facts = await executeAgentMessageAction(db, { action: 'receipts', project: PROJECT, recipient: 'ben/bob@beta', message_id: sent.message_id }, context) as Array<Record<string, unknown>>;
    const network = facts.find((fact) => fact.receipt_kind === 'network');
    expect(network?.network).toMatchObject({ state: 'delivered', attempts: 1, last_error_code: null, path: 'direct' });
    expect(typeof (network?.network as Record<string, unknown>).delivered_at).toBe('string');
  });
});

describe('status of a message to another machine', () => {
  const status = (messageId: unknown) => executeAgentMessageAction(db, {
    action: 'status', project: PROJECT, recipient: 'ben/bob@beta', message_id: messageId as string,
  }, context) as Promise<Record<string, unknown>>;

  it('before any delivery fact: handed to the network and not confirmed, never local queued', async () => {
    join();
    const sent = await send('ben/bob@beta', 'st-none');
    const result = await status(sent.message_id);
    expect(result.status).toBe('handed_to_network');
    expect(String(result.note)).toMatch(/not yet confirmed delivered/);
    expect(String(result.note)).not.toMatch(/inbox/);
  });

  it('still pending in the outbox after a failed attempt: same status, with the last error code', async () => {
    const joined = join();
    const sent = await send('ben/bob@beta', 'st-pending');
    enqueueOutgoing(db, joined, Date.now());
    const [entry] = dueOutgoingFor(db, peer.machineId, Date.now());
    recordAttempt(db, entry, { failure: 'unreachable' }, Date.now());
    const result = await status(sent.message_id);
    expect(result.status).toBe('handed_to_network');
    expect(String(result.note)).toMatch(/unreachable/);
  });

  it('delivered to the other machine', async () => {
    const joined = join();
    const sent = await send('ben/bob@beta', 'st-delivered');
    enqueueOutgoing(db, joined, Date.now());
    const [entry] = dueOutgoingFor(db, peer.machineId, Date.now());
    recordAttempt(db, entry, { ack: { result: 'accepted' }, path: 'direct' }, Date.now());
    const result = await status(sent.message_id);
    expect(result.status).toBe('delivered_to_machine');
    expect(String(result.note)).toMatch(/beta/);
  });

  it('refused or expired: said plainly, with the code', async () => {
    const joined = join();
    const sent = await send('ben/bob@beta', 'st-refused');
    enqueueOutgoing(db, joined, Date.now());
    const [entry] = dueOutgoingFor(db, peer.machineId, Date.now());
    recordAttempt(db, entry, { ack: { result: 'rejected', code: 'project_unknown' } }, Date.now());
    const result = await status(sent.message_id);
    expect(result.status).toBe('not_delivered');
    expect(String(result.note)).toMatch(/project_unknown/);
  });

  it('a local recipient is untouched: still queued', async () => {
    join();
    const sent = await send('alice-local', 'st-local');
    const result = await executeAgentMessageAction(db, {
      action: 'status', project: PROJECT, recipient: 'alice-local', message_id: sent.message_id as string,
    }, context) as Record<string, unknown>;
    expect(result.status).toBe('queued');
  });
});

describe('the router starting the bridge', () => {
  it('a machine that never joined: one stat of the network folder, and nothing starts', () => {
    const start = vi.fn(async () => ({ pid: 1, started: true }));
    const exists = vi.spyOn(fs, 'existsSync');
    const stat = vi.spyOn(fs, 'statSync');
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const result = maybeStartNetworkBridge({ dataDir: path.join(home, '.memesh'), dbPath: 'unused', db, networkDistDir: home, start });
      expect(result).toBe('not-joined');
      expect(exists.mock.calls).toEqual([[path.join(home, '.memesh', 'network')]]);
      expect(stat).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      exists.mockRestore();
      stat.mockRestore();
      read.mockRestore();
    }
    expect(start).not.toHaveBeenCalled();
  });

  it('a joined machine: started in the background, at most once per half minute, and a failure is reported, not thrown', async () => {
    join();
    fs.mkdirSync(path.join(home, '.memesh', 'network'), { recursive: true });
    const reports: string[] = [];
    const start = vi.fn(async () => { throw new Error('boom'); });
    const options = { dataDir: path.join(home, '.memesh'), dbPath: 'unused', db, networkDistDir: home, start, report: (m: string) => reports.push(m) };
    expect(maybeStartNetworkBridge(options)).toBe('starting');
    expect(maybeStartNetworkBridge(options)).toBe('recently-tried');
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toMatch(/could not start the network bridge: boom/);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

