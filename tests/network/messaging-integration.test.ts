// Two machines, two real bridges, relay off and direct addresses: messages and
// replies through the existing message tool, retries stored once, an offline
// machine catching up, expiry, refusal, and proof that nothing from memory crosses.
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import { readStatus } from '../../src/network/bridge-state.js';
import { NOTICE_SENDER, rememberPeer } from '../../src/network/courier.js';
import {
  FRAME_VERSION, MESSAGE_FRAME_KEYS, PRESENCE_ENTRY_KEYS, PRESENCE_FRAME_KEYS,
} from '../../src/network/frames.js';
import { loadIdentity } from '../../src/network/identity.js';
import { createLink, createNetwork, joinNetwork } from '../../src/network/operations.js';
import { remoteDiscoverCards } from '../../src/network/outbound.js';
import { isPlatformSupported } from '../../src/network/runtime.js';
import { NET_ALPN, type NetworkContext } from '../../src/network/types.js';
import {
  buildTree, contextFor, installRuntimeOnce, linkRuntime, loadIrohForTest, makeHome, removeTree, type Tree,
} from './helpers.js';
import type { IrohModule } from '../../src/network/iroh-types.js';

const lockText = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/network/runtime-lock.json'), 'utf8');
const supported = isPlatformSupported(lockText, process.platform, process.arch, process.platform === 'linux' ? 'glibc' : null);
const PROJECT = 'shared~0123456789abcdef0123456789abcdef';
const OTHER_PROJECT = 'alpha-only~fedcba9876543210fedcba9876543210';
const MARKER = `memory-marker-${randomBytes(6).toString('hex')}`;
const context = { transport: 'cli' as const, sourceHost: 'test-host' };

/** The core database open is one handle per process: each machine's turn, closed again. */
function withDb<T>(ctx: NetworkContext, use: (db: MemeshDatabase) => T): T {
  const db = openDatabase(ctx.dbPath);
  try {
    return use(db);
  } finally {
    closeDatabase();
  }
}

describe.skipIf(!supported || process.platform === 'win32')('messages between two machines', () => {
  let tree: Tree;
  let runtime: string;
  let iroh: IrohModule;
  let alpha: NetworkContext;
  let beta: NetworkContext;
  const homes: string[] = [];
  const frameLog = { alpha: '', beta: '' };
  let bridgesUpAt = 0;
  let gamma: NetworkContext;
  let blackHole: dgram.Socket;

  const machine = (log: string): NetworkContext => {
    const home = makeHome();
    homes.push(home);
    const ctx = contextFor(tree, home);
    ctx.env = { ...ctx.env, MEMESH_TEST_NETWORK_FRAME_LOG: log };
    linkRuntime(ctx, runtime);
    return ctx;
  };
  const sendFrom = (ctx: NetworkContext, sender: string, recipient: string, payload: string, extra: Record<string, unknown> = {}) =>
    withDb(ctx, (db) => executeAgentMessageAction(db, {
      action: 'send', project: PROJECT, sender, recipient, idempotency_key: `k-${payload}`, payload, ...extra,
    }, context)) as Promise<Record<string, unknown>>;
  const messages = (ctx: NetworkContext, recipient: string) => withDb(ctx, (db) => db.prepare(
    'SELECT message_id, sender, payload_json, reply_to_message_id, provenance_json FROM agent_messages WHERE recipient = ? ORDER BY created_at',
  ).all(recipient) as Array<{ message_id: string; sender: string; payload_json: string; reply_to_message_id: string | null; provenance_json: string }>);
  const fromNetwork = (ctx: NetworkContext, recipient: string) => messages(ctx, recipient).filter((row) => row.sender.includes('@'));
  const outbox = (ctx: NetworkContext, messageId: string) => withDb(ctx, (db) => db.prepare(
    'SELECT state, attempts, last_error_code, path FROM agent_network_outbox WHERE message_id = ?',
  ).get(messageId) as { state: string; attempts: number; last_error_code: string | null; path: string | null } | undefined);
  const memoryCounts = (ctx: NetworkContext) => withDb(ctx, (db) => ({
    entities: (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n,
    observations: (db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n,
  }));

  beforeAll(async () => {
    tree = await buildTree();
    runtime = installRuntimeOnce(tree);
    iroh = loadIrohForTest(runtime);
    frameLog.alpha = path.join(tree.root, 'frames-alpha.log');
    frameLog.beta = path.join(tree.root, 'frames-beta.log');
    alpha = machine(frameLog.alpha);
    beta = machine(frameLog.beta);
    createNetwork(alpha, { name: 'alpha', person: 'ann', relay: 'off' });

    // Each machine knows the project the way it would: it has used it.
    withDb(alpha, (db) => {
      sendAgentMessage(db, { project: PROJECT, sender: 'alice', recipient: 'alice', idempotency_key: 'seed', payload: 'seed', content_type: 'text/plain' });
      // Memory with a marker, which must never leave this machine.
      const entity = db.prepare("INSERT INTO entities (name, type) VALUES (?, 'note')").run(MARKER);
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.lastInsertRowid, `observation ${MARKER}`);
      // A live session here, so presence has something to say.
      db.prepare("INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, 'alice', 0)").run(PROJECT);
      db.prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, 'session-a1b2', 'alice', 'claude-channel')").run(PROJECT);
      db.prepare(`INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation, adapter_kind, router_instance_id, lease_expires_at_ms)
        VALUES ('conn-a', ?, 'alice', 'session-a1b2', 1, 'claude-channel', 'r', ?)`).run(PROJECT, Date.now() + 3_600_000);
    });
    // gamma joins first, so it comes before beta in the roster, and then never runs:
    // alpha is told an address for it where nothing ever answers (a bound UDP port
    // that drops everything), so every connect to gamma waits out its full deadline.
    gamma = machine(path.join(tree.root, 'frames-gamma.log'));
    const forGamma = await createLink(alpha, { includeAddresses: true, ttlHours: 1 });
    await joinNetwork(gamma, { link: forGamma.link, name: 'gamma', person: 'cat', relay: 'off' });
    blackHole = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => { blackHole.bind(0, '127.0.0.1', resolve); });
    const gammaId = loadIdentity(gamma.dataDir).machineId;
    withDb(alpha, (db) => rememberPeer(db, gammaId, null, [`127.0.0.1:${blackHole.address().port}`], Date.now()));
    const { link } = await createLink(alpha, { includeAddresses: true, ttlHours: 1 });
    await joinNetwork(beta, { link, name: 'beta', person: 'ben', relay: 'off' });
    withDb(beta, (db) => {
      sendAgentMessage(db, { project: PROJECT, sender: 'bob', recipient: 'bob', idempotency_key: 'seed', payload: 'seed', content_type: 'text/plain' });
    });
    await startBridge(alpha);
    await startBridge(beta);
    bridgesUpAt = Date.now();
  }, 300_000);

  afterAll(async () => {
    for (const ctx of [alpha, beta, gamma]) await stopBridge(ctx).catch(() => undefined);
    blackHole?.close();
    homes.forEach(removeTree);
    removeTree(path.dirname(path.dirname(path.dirname(runtime))));
    removeTree(tree.root);
  }, 120_000);

  // First, before anything else has run: alpha learns beta's route only from beta's
  // presence, and must answer at once, not at its next once-a-minute round.
  it('a machine heard from for the first time gets presence back at once', async () => {
    await expect.poll(() => withDb(beta, (db) => remoteDiscoverCards(db, PROJECT)).length, { timeout: 20_000, interval: 250 }).toBeGreaterThan(0);
    expect(Date.now() - bridgesUpAt).toBeLessThan(20_000);
  }, 40_000);

  // After both bridges have exchanged presence once, a change on one side must not
  // wait for the once-a-minute heartbeat. Going offline is shown by the card going
  // away: a machine's presence replaces everything it said before, so an agent it no
  // longer lists is gone, the same as when its entry expires.
  const bobCards = () => withDb(alpha, (db) => remoteDiscoverCards(db, PROJECT)).filter((card) => card.principal_id === 'bob');
  const bobComesOnline = (connection: string, session: string, leaseMs: number): void => withDb(beta, (db) => {
    db.prepare("INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, 'bob', 0)").run(PROJECT);
    db.prepare("INSERT OR IGNORE INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, ?, 'bob', 'claude-channel')").run(PROJECT, session);
    db.prepare(`INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation, adapter_kind, router_instance_id, lease_expires_at_ms)
      VALUES (?, ?, 'bob', ?, 1, 'claude-channel', 'r', ?)`).run(connection, PROJECT, session, Date.now() + leaseMs);
  });

  it('an agent that comes online on beta shows on alpha within seconds, and is gone within seconds when it leaves', async () => {
    // Both bridges are running and have exchanged presence (the test before this one).
    expect(bobCards()).toHaveLength(0);
    bobComesOnline('conn-b1', 'session-b001', 3_600_000);
    const onlineAt = Date.now();
    await expect.poll(() => bobCards().length, { timeout: 20_000, interval: 100 }).toBe(1);
    expect(Date.now() - onlineAt).toBeLessThan(5_000);
    expect(bobCards()[0]).toMatchObject({ address: 'ben/shared-claude-b001@beta', remote: true });

    withDb(beta, (db) => db.prepare("UPDATE agent_session_connections SET disconnected_at = CURRENT_TIMESTAMP, disconnect_reason = 'closed' WHERE connection_id = 'conn-b1'").run());
    const offlineAt = Date.now();
    await expect.poll(() => bobCards().length, { timeout: 20_000, interval: 100 }).toBe(0);
    expect(Date.now() - offlineAt).toBeLessThan(5_000);
  }, 60_000);

  it('an agent whose lease runs out is gone on alpha within seconds', async () => {
    bobComesOnline('conn-b2', 'session-b002', 3_000);
    await expect.poll(() => bobCards().length, { timeout: 20_000, interval: 100 }).toBe(1);
    const expiresAt = Date.now() + 3_000;
    await expect.poll(() => bobCards().length, { timeout: 20_000, interval: 100 }).toBe(0);
    expect(Date.now() - expiresAt).toBeLessThan(5_000);
  }, 60_000);

  it('with nothing changed, presence is not sent every second', async () => {
    const presenceLines = () => fs.readFileSync(frameLog.beta, 'utf8').split('\n').filter((line) => line.includes('"kind":"presence"')).length;
    const before = presenceLines();
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    // At most one heartbeat can fall in this window; a sender that ignored "unchanged" would send about eight.
    expect(presenceLines() - before).toBeLessThanOrEqual(1);
  }, 30_000);

  it('a message arrives once, from the roster name, and receipts say how it went', async () => {
    const before = memoryCounts(beta);
    const sent = await sendFrom(alpha, 'alice', 'ben/bob@beta', 'hello beta');
    expect(sent.delivery_note).toMatch(/goes to machine beta directly/);
    await expect.poll(() => fromNetwork(beta, 'bob').length, { timeout: 30_000, interval: 250 }).toBe(1);
    const [arrived] = fromNetwork(beta, 'bob');
    expect(arrived.sender).toBe('ann/alice@alpha');
    expect(JSON.parse(arrived.payload_json)).toBe('hello beta');
    expect(JSON.parse(arrived.provenance_json)).toEqual({ via: 'network', from_machine: 'alpha', origin_message_id: sent.message_id });
    await expect.poll(() => outbox(alpha, String(sent.message_id))?.state, { timeout: 10_000 }).toBe('delivered');
    const facts = await withDb(alpha, (db) => executeAgentMessageAction(db, {
      action: 'receipts', project: PROJECT, recipient: 'ben/bob@beta', message_id: sent.message_id,
    }, context)) as Array<Record<string, unknown>>;
    expect(facts.find((fact) => fact.receipt_kind === 'network')?.network).toMatchObject({ state: 'delivered', attempts: 1, path: 'direct' });
    expect(memoryCounts(beta)).toEqual(before);
  }, 60_000);

  it('a reply comes back, linked to the message it answers', async () => {
    const [arrived] = fromNetwork(beta, 'bob');
    await sendFrom(beta, 'bob', arrived.sender, 'hello alpha', { reply_to: arrived.message_id });
    await expect.poll(() => fromNetwork(alpha, 'alice').length, { timeout: 30_000, interval: 250 }).toBe(1);
    const [reply] = fromNetwork(alpha, 'alice');
    expect(reply.sender).toBe('ben/bob@beta');
    const original = messages(alpha, 'ben/bob@beta')[0];
    expect(reply.reply_to_message_id).toBe(original.message_id);
  }, 60_000);

  it('a retry after a lost answer is stored once', async () => {
    const original = messages(alpha, 'ben/bob@beta')[0];
    withDb(alpha, (db) => db.prepare("UPDATE agent_network_outbox SET state = 'pending', next_attempt_at_ms = 0 WHERE message_id = ?").run(original.message_id));
    await expect.poll(() => outbox(alpha, original.message_id)?.attempts, { timeout: 15_000 }).toBe(2);
    expect(outbox(alpha, original.message_id)?.state).toBe('delivered');
    expect(fromNetwork(beta, 'bob')).toHaveLength(1);
  }, 30_000);

  it('a machine that was offline gets it once it is back', async () => {
    await stopBridge(beta);
    const sent = await sendFrom(alpha, 'alice', 'ben/bob@beta', 'while you were away');
    await expect.poll(() => outbox(alpha, String(sent.message_id))?.attempts ?? 0, { timeout: 60_000, interval: 500 }).toBeGreaterThan(0);
    expect(outbox(alpha, String(sent.message_id))).toMatchObject({ state: 'pending', last_error_code: 'unreachable' });
    await startBridge(beta);
    await expect.poll(() => outbox(alpha, String(sent.message_id))?.state, { timeout: 30_000, interval: 250 }).toBe('delivered');
    expect(fromNetwork(beta, 'bob').filter((row) => JSON.parse(row.payload_json) === 'while you were away')).toHaveLength(1);
  }, 120_000);

  it('an unreachable machine costs one connect wait per round, not one per waiting message', async () => {
    await stopBridge(beta);
    try {
      const waiting = [];
      for (const n of [1, 2, 3, 4]) waiting.push(await sendFrom(alpha, 'alice', 'ben/bob@beta', `queued ${n}`));
      const last = await sendFrom(alpha, 'alice', 'ben/bob@beta', 'expires soon');
      // Due now, but its day ends in a few seconds: only a courier that is not stuck
      // behind the others' connect waits notices in time. (The bridge takes a message
      // into its outbox at the start of a round, so wait for that first.)
      await expect.poll(() => outbox(alpha, String(last.message_id))?.state, { timeout: 30_000, interval: 250 }).toBe('pending');
      withDb(alpha, (db) => db.prepare('UPDATE agent_network_outbox SET expires_at_ms = ? WHERE message_id = ?').run(Date.now() + 3_000, String(last.message_id)));
      const started = Date.now();
      await expect.poll(() => outbox(alpha, String(last.message_id))?.state, { timeout: 45_000, interval: 250 }).toBe('expired');
      // Four messages at one connect deadline (20 s) each would take 80 s.
      expect(Date.now() - started).toBeLessThan(45_000);
      expect(waiting.map((sent) => outbox(alpha, String(sent.message_id))?.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
    } finally {
      await startBridge(beta);
    }
    // They still arrive once beta is back.
    await expect.poll(() => fromNetwork(beta, 'bob').filter((row) => /^queued /.test(JSON.parse(row.payload_json) as string)).length, { timeout: 60_000, interval: 500 }).toBe(4);
  }, 180_000);

  it('after 24 hours it expires and the sender is told', async () => {
    await stopBridge(beta);
    try {
      const sent = await sendFrom(alpha, 'alice', 'ben/bob@beta', 'too late');
      // A round can be waiting on a connect to the stopped machine (up to 20 s) before it takes this in.
      await expect.poll(() => outbox(alpha, String(sent.message_id))?.state, { timeout: 30_000, interval: 250 }).toBe('pending');
      // The day is moved, not waited for: the deadline is set to now.
      withDb(alpha, (db) => db.prepare('UPDATE agent_network_outbox SET expires_at_ms = ? WHERE message_id = ?').run(Date.now(), String(sent.message_id)));
      await expect.poll(() => outbox(alpha, String(sent.message_id))?.state, { timeout: 45_000, interval: 250 }).toBe('expired');
      const notices = messages(alpha, 'alice').filter((row) => row.sender === NOTICE_SENDER).map((row) => JSON.parse(row.payload_json) as string);
      expect(notices.join('\n')).toMatch(new RegExp(`${String(sent.message_id)} to ben/bob@beta was not delivered: beta did not take it within one day.*state=expired`));
    } finally {
      await startBridge(beta);
    }
  }, 120_000);

  it('a project the other machine does not have is refused, and the sender is told', async () => {
    const sent = await withDb(alpha, (db) => executeAgentMessageAction(db, {
      action: 'send', project: OTHER_PROJECT, sender: 'alice', recipient: 'ben/bob@beta', idempotency_key: 'unknown-project', payload: 'where am I',
    }, context)) as Record<string, unknown>;
    await expect.poll(() => outbox(alpha, String(sent.message_id))?.state, { timeout: 45_000, interval: 250 }).toBe('rejected');
    expect(outbox(alpha, String(sent.message_id))?.last_error_code).toBe('project_unknown');
    const notices = withDb(alpha, (db) => db.prepare('SELECT payload_json FROM agent_messages WHERE project = ? AND sender = ?').all(OTHER_PROJECT, NOTICE_SENDER) as Array<{ payload_json: string }>);
    expect(notices.map((row) => JSON.parse(row.payload_json) as string).join('\n')).toMatch(/refused by beta.*code=project_unknown/);
  }, 60_000);

  it('beta sees alpha\'s live agent as a remote card, with the full address and no summary', async () => {
    await expect.poll(() => withDb(beta, (db) => remoteDiscoverCards(db, PROJECT)).length, { timeout: 30_000, interval: 500 }).toBeGreaterThan(0);
    const [card] = withDb(beta, (db) => remoteDiscoverCards(db, PROJECT));
    expect(card).toMatchObject({ remote: true, address: 'ann/shared-claude-a1b2@alpha', principal_id: 'alice', host_kind: 'claude' });
    expect(card).not.toHaveProperty('work_summary');
  }, 60_000);

  it('a machine that never answers does not hold up a message to one that does', async () => {
    // Sent together: the courier takes both in the same round, gamma's first.
    const stuck = await sendFrom(alpha, 'alice', 'cat/carol@gamma', 'for the machine that never answers');
    const sentAt = Date.now();
    const sent = await sendFrom(alpha, 'alice', 'ben/bob@beta', 'for the machine that answers');
    await expect.poll(() => outbox(alpha, String(sent.message_id))?.state, { timeout: 30_000, interval: 100 }).toBe('delivered');
    expect(Date.now() - sentAt).toBeLessThan(3_000);
    expect(outbox(alpha, String(stuck.message_id))?.state).toBe('pending');
  }, 60_000);

  it('presence reaches a machine that answers while another never does', async () => {
    // Forget beta's presence on alpha's side and its route, then restart beta: alpha
    // hears from it as if for the first time and answers with presence at once,
    // with gamma ahead of beta in the roster.
    withDb(beta, (db) => db.prepare('DELETE FROM agent_network_presence').run());
    withDb(alpha, (db) => db.prepare('DELETE FROM agent_network_peers WHERE machine_id = ?').run(loadIdentity(beta.dataDir).machineId));
    await stopBridge(beta);
    await startBridge(beta);
    const startedAt = Date.now();
    await expect.poll(() => withDb(beta, (db) => remoteDiscoverCards(db, PROJECT)).length, { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 90_000);

  it('nothing from memory crossed: every frame either bridge read is allowlisted and free of the marker', () => {
    const frames = [frameLog.alpha, frameLog.beta].flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean));
    expect(frames.length).toBeGreaterThan(3);
    let messagesSeen = 0;
    let presenceSeen = 0;
    for (const line of frames) {
      expect(line).not.toContain(MARKER);
      expect(line).not.toContain(PROJECT);
      const frame = JSON.parse(line) as Record<string, unknown>;
      expect(frame.version).toBe(FRAME_VERSION);
      if (frame.kind === 'message') {
        messagesSeen++;
        expect(Object.keys(frame).sort()).toEqual([...MESSAGE_FRAME_KEYS].sort());
      } else {
        presenceSeen++;
        expect(Object.keys(frame).sort()).toEqual([...PRESENCE_FRAME_KEYS].sort());
        for (const entry of frame.entries as Array<Record<string, unknown>>) expect(Object.keys(entry).sort()).toEqual([...PRESENCE_ENTRY_KEYS].sort());
      }
    }
    expect(messagesSeen).toBeGreaterThan(0);
    expect(presenceSeen).toBeGreaterThan(0);
    // The hook holds message contents: owner-only, in an owner-only folder.
    for (const file of [frameLog.alpha, frameLog.beta]) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
    }
    const presence = withDb(beta, (db) => JSON.stringify(db.prepare('SELECT * FROM agent_network_presence').all()));
    expect(presence).not.toContain(MARKER);
  });

  it('a non-member\'s frame never reaches the message store', async () => {
    const builder = iroh.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(Array.from(randomBytes(32)));
    builder.relayMode(iroh.RelayMode.disabled());
    const endpoint = await builder.bind();
    const before = messages(beta, 'bob').length;
    await expect.poll(() => readStatus(beta.dataDir)?.direct_addresses.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    try {
      const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(loadIdentity(beta.dataDir).machineId), null, readStatus(beta.dataDir)?.direct_addresses);
      const connection = await endpoint.connect(target, Array.from(Buffer.from(NET_ALPN)));
      try {
        const stream = await connection.openBi();
        await stream.send.writeAll(Array.from(Buffer.from(JSON.stringify({ version: 1, kind: 'message', sender: 'mallory', target: 'bob' }))));
        await stream.send.finish();
        await stream.recv.readToEnd(1024);
      } catch { /* closed before reading: expected */ }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await endpoint.close();
    }
    expect(messages(beta, 'bob')).toHaveLength(before);
    expect(fs.readFileSync(frameLog.beta, 'utf8')).not.toContain('mallory');
  }, 60_000);
});
