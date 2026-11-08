// The long-running bridge. Holds the data dir's control socket, answers joins when
// this machine owns the network, carries messages and presence between members on
// memesh/net/1, and refuses everyone else before reading a byte. Every refusal and
// every early exit leaves a record: a background process that fails quietly looks
// exactly like one that is working.

import fs from 'node:fs';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { logPath, writeStatus, type BridgeStatus } from './bridge-state.js';
import { holdControlSocket } from './control-socket.js';
import { advertisedAddresses, bindEndpoint, deadline, toBytes } from './endpoint.js';
import { ensureNetworkDir, loadIdentity, type Identity } from './identity.js';
import type { Connection, Endpoint, Incoming, IrohModule } from './iroh-types.js';
import { JOIN_REQUEST_MAX_BYTES, handleJoinRequest, type JoinReply } from './join-protocol.js';
import { explainLoadFailure, loadNative } from './native-loader.js';
import { RELAY_PING_INTERVAL_MS, applyRelayState, pingRelay, relayComplaint, type RelaySignals } from './relay-monitor.js';
import { findMember, verifyRoster } from './roster.js';
import { appendTestFrameLog } from './test-frame-log.js';
import { createAgentRouterNotifier } from '../core/agent-router.js';
import { getAgentRouterSocketPath } from '../core/paths.js';
import {
  buildMessageFrame, dueMachines, dueOutgoingFor, enqueueOutgoing, expireOverdue, frameLabel, localPresence, messagingAvailable,
  peerRoute, receiveMessage, receivePresence, recordAttempt, recordUnsendable, retryNowFor, type Joined, type OutboxEntry,
} from './courier.js';
import {
  ACK_MAX_BYTES, FRAME_MAX_BYTES, FRAME_VERSION, FrameError, encodeFrame, parseAck, parseFrame, type Ack, type Frame,
} from './frames.js';
import type { AgentMessagePostCommitNotifier } from '../core/agent-messaging.js';
import { openNetworkStore, readConfig, signedRosterOf, type NetworkConfig } from './store.js';
import {
  EXIT_ALREADY_RUNNING, EXIT_HOLDER_UNRESPONSIVE, JOIN_ALPN, NET_ALPN, RELAY_OFF, errorMessage, runtimeDir,
} from './types.js';

const RELAY_ONLINE_DEADLINE_MS = 20_000;
const HANDSHAKE_DEADLINE_MS = 20_000;
const STREAM_DEADLINE_MS = 15_000;
const CLOSE_DEADLINE_MS = 5_000;
// A held write lock must not stop this process for long: the database calls are
// synchronous, and every connection and signal waits behind them.
export const BRIDGE_BUSY_TIMEOUT_MS = 3_000;
const HEARTBEAT_MS = 1_000;
const STATUS_REFRESH_MS = 30_000;
// How long the control socket may stay unreadable (not gone) before the bridge gives up.
const SOCKET_UNREADABLE_LIMIT_MS = 30_000;
const LOG_MAX_BYTES = 1024 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 32;
const COURIER_INTERVAL_MS = 1_000;
const PRESENCE_INTERVAL_MS = 60_000;
const SEND_CONNECT_DEADLINE_MS = 20_000;

function appendLog(dataDir: string, event: string, detail: Record<string, unknown> = {}): void {
  try {
    const file = logPath(dataDir);
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, line(event, detail), { mode: 0o600 });
  } catch {
    // The folder itself may be what failed. Stderr was opened onto bridge.log at
    // spawn, so it still reaches the same file.
    try { process.stderr.write(line(event, detail)); } catch { /* nowhere left to write */ }
  }
}

function line(event: string, detail: Record<string, unknown>): string {
  return `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail })}\n`;
}

export async function serve(dataDir: string, dbPath: string): Promise<number> {
  try { process.umask(0o077); } catch { /* non-POSIX */ }

  ensureNetworkDir(dataDir);
  // Replaced by the real stop once there is an endpoint to close.
  let requestStop = (): void => {
    appendLog(dataDir, 'stopped', { reason: 'asked during startup' });
    process.exit(0);
  };
  let ready = false;
  const control = await holdControlSocket(dataDir, {
    isReady: () => ready,
    stop: () => requestStop(),
    onProblem: (message) => appendLog(dataDir, 'control_problem', { error: message }),
  });
  if (control.kind === 'already-running') {
    appendLog(dataDir, 'exit_already_running');
    return EXIT_ALREADY_RUNNING;
  }
  if (control.kind === 'holder-unresponsive') {
    appendLog(dataDir, 'exit_holder_unresponsive');
    return EXIT_HOLDER_UNRESPONSIVE;
  }

  const startedAt = new Date().toISOString();
  const status: BridgeStatus = {
    pid: process.pid,
    started_at: startedAt,
    updated_at: startedAt,
    state: 'starting',
    relay_state: 'off',
    last_error: null,
    last_error_at: null,
    direct_addresses: [],
    joins_accepted: 0,
    joins_refused: 0,
    non_member_refused: 0,
    frames_received: 0,
  };
  // Once the socket is gone or someone else's, the status file may be theirs too.
  const publish = (): void => {
    if (control.ownership() === 'lost') return;
    status.updated_at = new Date().toISOString();
    try {
      writeStatus(dataDir, status);
    } catch (err) {
      appendLog(dataDir, 'status_write_failed', { error: errorMessage(err) });
    }
  };
  const recordError = (event: string, message: string): void => {
    status.last_error = message;
    status.last_error_at = new Date().toISOString();
    appendLog(dataDir, event, { error: message });
    publish();
  };
  const fail = (event: string, message: string): number => {
    status.state = 'failed';
    recordError(event, message);
    control.close();
    return 1;
  };
  publish();

  let db: MemeshDatabase;
  let config: NetworkConfig | null;
  try {
    db = openNetworkStore(dbPath, { busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS });
    config = readConfig(db);
  } catch (err) {
    return fail('exit_database', `Cannot open the database: ${errorMessage(err)}`);
  }
  if (!config) {
    db.close();
    return fail('exit_not_joined', 'This machine has not joined a network.');
  }

  const { machine_id: machineId, owner_id: ownerId, relay_url: relayUrl } = config;
  const isOwner = ownerId === machineId;
  let identity: Identity;
  try {
    identity = loadIdentity(dataDir);
  } catch (err) {
    db.close();
    return fail('exit_identity', errorMessage(err));
  }
  if (identity.machineId !== machineId) {
    db.close();
    return fail('exit_identity', 'The machine key does not match the one this network was joined with.');
  }

  let iroh: IrohModule;
  try {
    iroh = loadNative(runtimeDir(dataDir));
  } catch (err) {
    db.close();
    return fail('exit_native', `Cannot load the networking component: ${explainLoadFailure(err)}`);
  }

  let endpoint: Endpoint;
  try {
    endpoint = await bindEndpoint(iroh, identity.secret, relayUrl, isOwner ? [JOIN_ALPN, NET_ALPN] : [NET_ALPN]);
  } catch (err) {
    db.close();
    return fail('exit_bind', `Cannot open a network connection: ${errorMessage(err)}`);
  }

  status.state = 'running';
  ready = true;
  status.relay_state = relayUrl === RELAY_OFF ? 'off' : 'connecting';
  publish();
  appendLog(dataDir, 'running', { relay_state: status.relay_state, owner: isOwner });

  const relaySignals: RelaySignals = { online: false, deadlinePassed: false, reachable: null };
  const refreshRelayState = (): void => {
    if (!applyRelayState(status, relaySignals, relayUrl)) return;
    appendLog(dataDir, 'relay_state', { relay_state: status.relay_state });
    if (status.relay_state === 'unreachable') recordError('relay_unreachable', relayComplaint(relayUrl));
    else publish();
  };

  const relayTimers: NodeJS.Timeout[] = [];
  if (status.relay_state === 'connecting') {
    endpoint.online().then(() => {
      relaySignals.online = true;
      refreshRelayState();
    }, (err: unknown) => {
      recordError('relay_failed', `The relay failed: ${errorMessage(err)}`);
    });
    relayTimers.push(setTimeout(() => {
      relaySignals.deadlinePassed = true;
      refreshRelayState();
    }, RELAY_ONLINE_DEADLINE_MS));
    let pingInFlight = false;
    const ping = (): void => {
      if (pingInFlight) return;
      pingInFlight = true;
      void pingRelay(relayUrl).then((reachable) => {
        pingInFlight = false;
        relaySignals.reachable = reachable;
        refreshRelayState();
      });
    };
    ping();
    relayTimers.push(setInterval(ping, RELAY_PING_INTERVAL_MS));
  }

  // This timer also publishes direct addresses as they appear after bind.
  let lastPublished = Date.now();
  let unreadableSince: number | null = null;
  const heartbeat = setInterval(() => {
    const ownership = control.ownership();
    if (ownership === 'lost') {
      void abandon();
      return;
    }
    if (ownership === 'unreadable') {
      // A brief read error says nothing about who owns the socket: keep serving and look again.
      if (unreadableSince === null) {
        unreadableSince = Date.now();
        appendLog(dataDir, 'control_socket_unreadable_retrying');
      } else if (Date.now() - unreadableSince >= SOCKET_UNREADABLE_LIMIT_MS) {
        clearInterval(heartbeat);
        recordError('control_socket_unreadable', `The control socket could not be read for ${SOCKET_UNREADABLE_LIMIT_MS / 1000} s, so this bridge stopped.`);
        void stop('control_socket_unreadable', 1);
      }
      return;
    }
    if (unreadableSince !== null) {
      unreadableSince = null;
      appendLog(dataDir, 'control_socket_readable_again');
    }
    let addresses: string[] | null = null;
    try {
      addresses = advertisedAddresses(endpoint);
    } catch (err) {
      appendLog(dataDir, 'addresses_failed', { error: errorMessage(err) });
    }
    const changed = addresses !== null && addresses.join() !== status.direct_addresses.join();
    if (changed) status.direct_addresses = addresses as string[];
    if (changed || Date.now() - lastPublished >= STATUS_REFRESH_MS) {
      lastPublished = Date.now();
      publish();
    }
  }, HEARTBEAT_MS);

  let stopping = false;
  const stop = async (reason: string, exitCode: number): Promise<never> => {
    if (stopping) await new Promise(() => { /* the first stop exits */ });
    stopping = true;
    clearInterval(heartbeat);
    relayTimers.forEach(clearTimeout);
    try {
      await deadline(endpoint.close(), CLOSE_DEADLINE_MS, 'closing the endpoint');
    } catch (err) {
      appendLog(dataDir, 'close_failed', { error: errorMessage(err) });
    }
    status.state = exitCode === 0 ? 'stopped' : 'failed';
    appendLog(dataDir, 'stopped', { reason });
    publish();
    try { db.close(); } catch { /* exiting */ }
    control.close();
    process.exit(exitCode);
  };
  // The socket path is gone or someone else's, so this process can no longer be
  // reached or stopped, and another bridge may be serving. It leaves at once, and
  // leaves status and the path alone: those may belong to that other bridge now.
  const abandon = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    relayTimers.forEach(clearTimeout);
    appendLog(dataDir, 'control_socket_lost', { detail: 'The control socket path is gone or replaced, so this bridge is exiting.' });
    await deadline(endpoint.close(), CLOSE_DEADLINE_MS, 'closing the endpoint').catch(() => undefined);
    try { db.close(); } catch { /* exiting */ }
    process.exit(1);
  };
  requestStop = () => { void stop('asked over the control socket', 0); };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => { void stop(signal, 0); });
  }
  process.on('uncaughtException', (err) => {
    recordError('uncaught_exception', errorMessage(err));
    void stop('uncaught_exception', 1);
  });
  process.on('unhandledRejection', (err) => {
    recordError('unhandled_rejection', errorMessage(err));
    void stop('unhandled_rejection', 1);
  });

  /** Let the peer read the last bytes, then close: an immediate close discards unsent data. */
  const finishConnection = async (connection: Connection): Promise<void> => {
    await deadline(connection.closed(), CLOSE_DEADLINE_MS, 'waiting for the peer to close').catch(() => undefined);
    connection.close(0n, toBytes('done'));
  };

  const answerJoin = async (connection: Connection, remoteId: string): Promise<void> => {
    const stream = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, 'waiting for the join request');
    const request = Buffer.from(await deadline(stream.recv.readToEnd(JOIN_REQUEST_MAX_BYTES), STREAM_DEADLINE_MS, 'reading the join request'));
    let reply: JoinReply;
    try {
      reply = handleJoinRequest(db, identity, remoteId, request, Date.now());
    } catch (err) {
      recordError('join_failed', errorMessage(err));
      reply = { ok: false, error: 'internal' };
    }
    if (reply.ok) {
      status.joins_accepted++;
      appendLog(dataDir, 'join_accepted', { machine_id: remoteId });
    } else {
      status.joins_refused++;
      appendLog(dataDir, 'join_refused', { machine_id: remoteId, reason: reply.error });
    }
    publish();
    await deadline(stream.send.writeAll(toBytes(JSON.stringify(reply))), STREAM_DEADLINE_MS, 'sending the join reply');
    await stream.send.finish();
    await finishConnection(connection);
  };

  /** The roster as it is now: read fresh, verified, so a machine that just joined is let in. */
  const joinedNow = (): Joined => {
    const current = readConfig(db);
    if (!current) throw new Error('The network settings are gone from the database.');
    return { config: current, roster: verifyRoster(signedRosterOf(current), ownerId, current.network_id) };
  };

  let notifier: AgentMessagePostCommitNotifier | undefined;
  try {
    notifier = createAgentRouterNotifier(getAgentRouterSocketPath());
  } catch {
    notifier = undefined; // No usable router path: the message is stored and found on the next drain.
  }

  let lastPresenceAt = 0;
  const answer = (frame: Frame, joined: Joined, remoteId: string): Ack => {
    const member = findMember(joined.roster, remoteId);
    if (!member) return { result: 'rejected', code: 'not_a_member' };
    if (frame.kind === 'presence') {
      const firstContact = !peerRoute(db, remoteId);
      receivePresence(db, member, frame, Date.now());
      retryNowFor(db, remoteId, Date.now());
      if (firstContact) lastPresenceAt = 0; // A machine heard from for the first time hears back on the next round, not in a minute.
      return { result: 'accepted' };
    }
    if (!messagingAvailable(db)) {
      recordError('messaging_unavailable', 'A message arrived, but the message tables do not exist here yet; it will be retried.');
      return { result: 'retry', code: 'messaging_unavailable' };
    }
    return receiveMessage(db, joined, member, frame, notifier);
  };

  const answerMember = async (connection: Connection, remoteId: string): Promise<void> => {
    // Membership comes before anything is read: a non-member is closed with no data read.
    const joined = joinedNow();
    if (!findMember(joined.roster, remoteId)) {
      connection.close(1n, toBytes('not_a_member'));
      status.non_member_refused++;
      appendLog(dataDir, 'non_member_refused', { machine_id: remoteId });
      publish();
      return;
    }
    const stream = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, 'waiting for a member stream');
    const bytes = Buffer.from(await deadline(stream.recv.readToEnd(FRAME_MAX_BYTES), STREAM_DEADLINE_MS, 'reading a member stream'));
    // TEST HOOK, off unless this variable is set: every frame read, as read (see test-frame-log.ts).
    const frameLog = process.env.MEMESH_TEST_NETWORK_FRAME_LOG;
    if (frameLog) {
      const refused = appendTestFrameLog(frameLog, bytes);
      if (refused) recordError('test_frame_log_refused', refused);
    }
    let ack: Ack;
    try {
      const frame = parseFrame(bytes);
      ack = answer(frame, joined, remoteId);
      appendLog(dataDir, 'frame_received', { machine_id: remoteId, frame: frameLabel(frame), result: ack.result, code: ack.code ?? null });
    } catch (err) {
      if (err instanceof FrameError) ack = { result: 'rejected', code: err.code };
      else {
        recordError('frame_failed', errorMessage(err));
        ack = { result: 'retry', code: 'internal' };
      }
    }
    await deadline(stream.send.writeAll(toBytes(JSON.stringify(ack))), STREAM_DEADLINE_MS, 'answering a member');
    await stream.send.finish();
    status.frames_received++;
    publish();
    await finishConnection(connection);
  };

  /** One frame to one member on its own stream; the answer, and whether it went through the relay. */
  const sendFrame = async (target: string, frame: Frame): Promise<{ ack: Ack; path: string | null }> => {
    const route = peerRoute(db, target);
    const relay = route?.relay ?? (relayUrl === RELAY_OFF ? null : relayUrl);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(target), relay, route?.addrs ?? []);
    const connection = await deadline(endpoint.connect(address, toBytes(NET_ALPN)), SEND_CONNECT_DEADLINE_MS, 'connecting to a member');
    try {
      const stream = await deadline(connection.openBi(), STREAM_DEADLINE_MS, 'opening a stream');
      await deadline(stream.send.writeAll(toBytes(encodeFrame(frame))), STREAM_DEADLINE_MS, 'sending a frame');
      await deadline(stream.send.finish(), STREAM_DEADLINE_MS, 'sending a frame');
      const ack = parseAck(Buffer.from(await deadline(stream.recv.readToEnd(ACK_MAX_BYTES), STREAM_DEADLINE_MS, 'waiting for the answer')));
      let path: string | null = null;
      try {
        const selected = connection.paths().find((candidate) => candidate.isSelected);
        path = selected ? (selected.isRelay ? 'relay' : 'direct') : null;
      } catch { /* the path is informational */ }
      return { ack, path };
    } finally {
      connection.close(0n, toBytes('done'));
    }
  };

  let courierBusy = false;
  /** One attempt; false when the machine could not be reached, so its run stops there. */
  const deliver = async (joined: Joined, entry: OutboxEntry): Promise<boolean> => {
    const frame = buildMessageFrame(db, joined, entry);
    if (typeof frame === 'string') {
      recordUnsendable(db, entry, frame, notifier);
      appendLog(dataDir, 'message_unsendable', { delivery_id: entry.delivery_id, code: frame });
      return true;
    }
    try {
      const { ack, path } = await sendFrame(entry.machine_id, frame);
      const outcome = recordAttempt(db, entry, { ack, path }, Date.now(), notifier);
      appendLog(dataDir, 'message_attempt', { delivery_id: entry.delivery_id, outcome, code: ack.code ?? null, path });
      return true;
    } catch (err) {
      if (stopping) return false; // The endpoint closed under it: not an attempt that says anything.
      const outcome = recordAttempt(db, entry, { failure: 'unreachable' }, Date.now(), notifier);
      appendLog(dataDir, 'message_attempt', { delivery_id: entry.delivery_id, outcome, code: 'unreachable', error: errorMessage(err) });
      return false;
    }
  };
  // Each machine is handled on its own: a member that does not answer costs its own
  // connect deadline, never another member's message or presence.
  const sendingTo = new Set<string>();
  const announcingTo = new Set<string>();
  /** One machine's due messages, in order; stops at the first it cannot reach. */
  const deliverTo = async (joined: Joined, target: string): Promise<void> => {
    sendingTo.add(target);
    try {
      for (const entry of dueOutgoingFor(db, target, Date.now())) {
        if (stopping) return;
        if (!(await deliver(joined, entry))) return;
      }
    } catch (err) {
      if (!stopping) recordError('courier_failed', errorMessage(err));
    } finally {
      sendingTo.delete(target);
    }
  };
  // What each member was last sent, as text: presence goes out when it changes (an
  // agent here connected, disconnected or let its lease run out), plus a heartbeat.
  const sentTo = new Map<string, string>();
  /** Send presence to every member whose last copy differs, or to all on a heartbeat. */
  const announce = (joined: Joined, heartbeat: boolean): void => {
    const frame: Frame = {
      version: FRAME_VERSION,
      kind: 'presence',
      relay: relayUrl === RELAY_OFF ? null : relayUrl,
      addrs: advertisedAddresses(endpoint),
      entries: localPresence(db, joined, Date.now()),
    };
    const content = JSON.stringify(frame);
    for (const member of joined.roster.members) {
      const target = member.machine_id;
      if (target === machineId || announcingTo.has(target)) continue;
      if (!heartbeat && sentTo.get(target) === content) continue; // Nothing new for it.
      if (!peerRoute(db, target) && relayUrl === RELAY_OFF) continue; // No way to reach it yet.
      // Recorded when sent, so a member that does not answer is tried again on the
      // heartbeat or the next change, not every second.
      sentTo.set(target, content);
      announcingTo.add(target);
      void sendFrame(target, frame)
        .catch((err: unknown) => { if (!stopping) appendLog(dataDir, 'presence_unreachable', { machine_id: target, error: errorMessage(err) }); })
        .finally(() => { announcingTo.delete(target); });
    }
  };
  /** Forward what is waiting, expire what has waited too long, and say who is live here. */
  const courier = async (): Promise<void> => {
    if (courierBusy || stopping) return;
    courierBusy = true;
    try {
      if (!messagingAvailable(db)) return;
      const joined = joinedNow();
      const now = Date.now();
      enqueueOutgoing(db, joined, now);
      expireOverdue(db, now, notifier);
      // Started, not awaited: each machine runs on its own, at most one run each at a time.
      for (const target of dueMachines(db, now)) {
        if (!sendingTo.has(target)) void deliverTo(joined, target);
      }
      const heartbeat = now - lastPresenceAt >= PRESENCE_INTERVAL_MS;
      if (heartbeat) lastPresenceAt = now;
      announce(joined, heartbeat);
    } catch (err) {
      recordError('courier_failed', errorMessage(err));
    } finally {
      courierBusy = false;
    }
  };
  relayTimers.push(setInterval(() => { void courier(); }, COURIER_INTERVAL_MS));
  void courier();

  const handleIncoming = async (incoming: Incoming): Promise<void> => {
    let connection: Connection | undefined;
    try {
      const accepting = await deadline(incoming.accept(), HANDSHAKE_DEADLINE_MS, 'accepting a connection');
      connection = await deadline(accepting.connect(), HANDSHAKE_DEADLINE_MS, 'the connection handshake');
      const remoteId = connection.remoteId().toString();
      const alpn = Buffer.from(connection.alpn()).toString();
      if (alpn === JOIN_ALPN && isOwner) await answerJoin(connection, remoteId);
      else if (alpn === NET_ALPN) await answerMember(connection, remoteId);
      else {
        connection.close(2n, toBytes('unknown_protocol'));
        appendLog(dataDir, 'unknown_protocol_refused', { machine_id: remoteId });
      }
    } catch (err) {
      recordError('connection_failed', errorMessage(err));
      try { connection?.close(3n, toBytes('error')); } catch { /* already closed */ }
    }
  };

  let inFlight = 0;
  for (;;) {
    let incoming: Incoming | null;
    try {
      incoming = await endpoint.acceptNext();
    } catch (err) {
      recordError('accept_failed', errorMessage(err));
      return stop('accept_failed', 1);
    }
    if (incoming === null) return stop('endpoint_closed', stopping ? 0 : 1);
    if (inFlight >= MAX_CONCURRENT_CONNECTIONS) {
      appendLog(dataDir, 'too_many_connections_refused');
      void incoming.refuse().catch((err: unknown) => appendLog(dataDir, 'refuse_failed', { error: errorMessage(err) }));
      continue;
    }
    inFlight++;
    void handleIncoming(incoming).finally(() => { inFlight--; });
  }
}
