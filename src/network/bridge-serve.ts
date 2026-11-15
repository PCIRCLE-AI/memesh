// The long-running bridge. Holds the data dir's control socket, answers joins when
// this machine owns the network, carries messages and presence between members on
// memesh/net/2, with bounded signed-roster exchange before membership. Every refusal and
// every early exit leaves a record: a background process that fails quietly looks
// exactly like one that is working.

import fs from 'node:fs';
import path from 'node:path';
import { ConversationMessages } from '../core/conversation-messages.js';
import { assertLegacyPathsAreDifferent } from '../core/conversation-message-migration.js';
import { getDbPath } from '../core/paths.js';
import { wakeConversationMessage } from '../host-adapters/conversation-wake.js';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { logPath, writeStatus, type BridgeStatus } from './bridge-state.js';
import { holdControlSocket } from './control-socket.js';
import {
  MEMBERSHIP_MAX_BYTES, MEMBERSHIP_ACK_MAX_BYTES, MEMBERSHIP_DEADLINE_MS,
  parseMembershipFrame, parseMembershipAck, membershipConfig, removeMember, clearMembership, receiveMembershipRoster,
  type MembershipAction, type MembershipResult, type MembershipFrame, type MembershipAck,
} from './membership.js';
import { advertisedAddresses, bindEndpoint, deadline, toBytes } from './endpoint.js';
import { ensureNetworkDir, loadIdentity, type Identity } from './identity.js';
import type { Connection, Endpoint, Incoming, IrohModule } from './iroh-types.js';
import { JOIN_REQUEST_MAX_BYTES, handleJoinRequest, type JoinReply } from './join-protocol.js';
import { explainLoadFailure, loadNative } from './native-loader.js';
import { RELAY_PING_INTERVAL_MS, applyRelayState, pingRelay, relayComplaint, type RelaySignals } from './relay-monitor.js';
import { findMember, verifyRoster } from './roster.js';
import { appendTestFrameLog } from './test-frame-log.js';
import {
  peerRoute, rememberPeer, type Joined,
} from './courier.js';
import {
  ACK_MAX_BYTES, FRAME_MAX_BYTES, FrameError, parseAck, type Ack,
  exchangeRosterStream, parseConversationFrame, conversationPresenceFrames, type ConversationFrame,
} from './frames.js';
import { authorizeNetworkPeer, exchangeRoster, openNetworkStore, readConfig, signedRosterOf, type NetworkConfig } from './store.js';
import {
  EXIT_ALREADY_RUNNING, EXIT_HOLDER_UNRESPONSIVE, JOIN_ALPN, NET_ALPN, MEMBERSHIP_ALPN, RELAY_OFF, errorMessage, runtimeDir, type SignedRoster,
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
  // Explicit messages opens must retain the default opener's graph separation.
  assertLegacyPathsAreDifferent(getDbPath(), path.join(dataDir, 'messages.db'));
  assertLegacyPathsAreDifferent(getDbPath(), dbPath);
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
    membership: action => membershipAction(action),
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
    db = openNetworkStore(dbPath, { busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS, metadataOnly: true });
    config = readConfig(db);
  } catch (err) {
    return fail('exit_database', `Cannot open the database: ${errorMessage(err)}`);
  }
  if (!config) {
    db.close();
    return fail('exit_not_joined', 'This machine has not joined a network.');
  }

  const { machine_id: machineId, owner_id: ownerId, relay_url: relayUrl, network_id: networkId } = config;
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
    endpoint = await bindEndpoint(iroh, identity.secret, relayUrl, isOwner ? [JOIN_ALPN, NET_ALPN, MEMBERSHIP_ALPN] : [NET_ALPN, MEMBERSHIP_ALPN]);
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
    if (current.network_id !== networkId || current.owner_id !== ownerId || current.machine_id !== machineId) throw new Error('Bridge network identity changed');
    return { config: current, roster: verifyRoster(signedRosterOf(current), ownerId, current.network_id) };
  };

  const memberConnections = new Map<Connection, string>();
  const authorize = (remoteId: string): Joined => {
    authorizeNetworkPeer(db, remoteId);
    return joinedNow();
  };
  const revokeConnections = (): void => {
    for (const [connection, remoteId] of memberConnections) {
      try { authorize(remoteId); } catch {
        connection.close(1n, toBytes('not_a_member'));
        memberConnections.delete(connection);
      }
    }
  };

  // All management uses this process's one endpoint. A late connect is closed
  // even if its bounded caller has already timed out.
  const requestMembership = async (target: string, frame: MembershipFrame, expected: NetworkConfig): Promise<MembershipAck> => {
    const until = Date.now() + MEMBERSHIP_DEADLINE_MS;
    const remaining = (): number => Math.max(1, until - Date.now());
    parseMembershipFrame(Buffer.from(JSON.stringify(frame)));
    membershipConfig(db, expected);
    const route = peerRoute(db, target);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(target), route?.relay ?? (relayUrl === RELAY_OFF ? null : relayUrl), route?.addrs ?? []);
    let expired = false;
    let connection: Connection | undefined;
    const pending = endpoint.connect(address, toBytes(MEMBERSHIP_ALPN));
    void pending.then(c => { if (expired) c.close(1n, toBytes('management_timeout')); }, () => undefined);
    try {
      connection = await deadline(pending, remaining(), 'connecting for membership');
      if (connection.remoteId().toString() !== target) throw new Error('Wrong membership peer');
      membershipConfig(db, expected);
      const stream = await deadline(connection.openBi(), remaining(), 'opening membership request');
      await deadline(stream.send.writeAll(toBytes(JSON.stringify(frame))), remaining(), 'sending membership request');
      await deadline(stream.send.finish(), remaining(), 'finishing membership request');
      return parseMembershipAck(Buffer.from(await deadline(stream.recv.readToEnd(MEMBERSHIP_ACK_MAX_BYTES), remaining(), 'receiving membership confirmation')), expected.network_id);
    } finally { expired = true; connection?.close(0n, toBytes('membership_done')); }
  };

  const finishDeparture = (): void => {
    // A concurrent create/join must not have its new bridge stopped by an old ACK.
    if (!stopping && control.stillOurs() && readConfig(db) === null) {
      status.membership_departure = { network_id: networkId, owner_id: ownerId, machine_id: machineId };
      void stop('membership revoked', 0);
    }
  };
  const broadcastRoster = async (expected: NetworkConfig, signed: SignedRoster, targets: string[], skip?: string): Promise<string[]> => {
    const todo = [...new Set(targets)].filter(id => id !== machineId && id !== skip);
    const unsynchronized: string[] = [];
    const until = Date.now() + 15_000;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
      for (;;) {
        const target = todo[next++]; if (!target) return;
        if (Date.now() >= until || stopping) { unsynchronized.push(target); continue; }
        try {
          const ack = await requestMembership(target, { version: 1, op: 'roster', network_id: expected.network_id, roster: signed }, expected);
          if (ack.roster_version < verifyRoster(signed, expected.owner_id, expected.network_id).version) throw new Error('Roster not acknowledged');
        } catch { unsynchronized.push(target); }
      }
    }));
    return unsynchronized.sort();
  };

  let membershipBusy = false;
  const membershipAction = async (action: MembershipAction): Promise<{ result: MembershipResult; afterReply?: () => void }> => {
    if (membershipBusy || stopping || !control.stillOurs()) throw new Error('Membership action unavailable');
    membershipBusy = true;
    try {
      const expected = joinedNow().config;
      if (action.network_id !== expected.network_id || action.machine_id !== expected.machine_id) throw new Error('Membership control binding changed');
      if (action.action === 'remove') {
        const changed = removeMember(db, identity, expected, action.target!);
        revokeConnections();
        const unsynchronized = await broadcastRoster(expected, changed.signed, [...changed.priorMembers, changed.removed]);
        return { result: { action: 'remove', network_id: expected.network_id, roster_version: verifyRoster(changed.signed, ownerId, expected.network_id).version,
          removed: changed.removed, already_removed: changed.alreadyRemoved, unsynchronized } };
      }
      if (isOwner) throw new Error('Owner departure is not supported; no membership was changed.');
      const ack = await requestMembership(ownerId, { version: 1, op: 'leave-self', network_id: expected.network_id }, expected);
      if (ack.member || ack.roster_version < verifyRoster(signedRosterOf(expected), ownerId, expected.network_id).version) throw new Error('Owner has not confirmed departure');
      if (stopping || !control.stillOurs()) throw new Error('Bridge changed before departure confirmation');
      clearMembership(db, expected, ack.roster_version); revokeConnections();
      return { result: { action: 'leave', network_id: expected.network_id, roster_version: ack.roster_version,
        removed: machineId, already_removed: false, unsynchronized: null }, afterReply: finishDeparture };
    } finally { membershipBusy = false; }
  };

  const answerMembership = async (connection: Connection, remoteId: string): Promise<void> => {
    const stream = await deadline(connection.acceptBi(), MEMBERSHIP_DEADLINE_MS, 'waiting for membership request');
    const frame = parseMembershipFrame(Buffer.from(await deadline(stream.recv.readToEnd(MEMBERSHIP_MAX_BYTES), MEMBERSHIP_DEADLINE_MS, 'reading membership request')));
    const expected = joinedNow().config;
    if (frame.network_id !== expected.network_id) throw new Error('Wrong membership network');
    let ack: MembershipAck;
    let departed = false;
    if (frame.op === 'roster') {
      // Delivery is owner-authenticated as well as owner-signed, including self removal.
      if (remoteId !== expected.owner_id) throw new Error('Only the owner may push membership');
      const accepted = receiveMembershipRoster(db, expected, frame.roster);
      revokeConnections(); departed = !accepted.member;
      ack = { version: 1, network_id: expected.network_id, roster_version: accepted.version, member: accepted.member };
    } else {
      if (!isOwner || identity.machineId !== expected.owner_id) throw new Error('Membership request requires the owner');
      // No requested victim, no roster returned, even for previously removed identities.
      if (frame.op === 'leave-self') {
        const changed = removeMember(db, identity, expected, remoteId);
        revokeConnections();
        void broadcastRoster(expected, changed.signed, changed.priorMembers, remoteId).then(unsynchronized => {
          appendLog(dataDir, 'membership_propagation', { version: verifyRoster(changed.signed, ownerId, expected.network_id).version, unsynchronized });
        }).catch(error => recordError('membership_propagation_failed', errorMessage(error)));
      }
      const current = joinedNow();
      ack = { version: 1, network_id: expected.network_id, roster_version: current.roster.version, member: Boolean(findMember(current.roster, remoteId)) };
    }
    try {
      await deadline(stream.send.writeAll(toBytes(JSON.stringify(ack))), MEMBERSHIP_DEADLINE_MS, 'answering membership');
      await deadline(stream.send.finish(), MEMBERSHIP_DEADLINE_MS, 'finishing membership answer');
      await finishConnection(connection);
    } finally { if (departed) finishDeparture(); }
  };

  let selfStatusBusy = false;
  const checkSelfMembership = async (): Promise<void> => {
    if (isOwner || selfStatusBusy || stopping) return;
    selfStatusBusy = true;
    try {
      const expected = joinedNow().config;
      const ack = await requestMembership(ownerId, { version: 1, op: 'self-status', network_id: expected.network_id }, expected);
      if (!ack.member && ack.roster_version >= verifyRoster(signedRosterOf(expected), ownerId, expected.network_id).version) {
        if (stopping || !control.stillOurs()) return;
        clearMembership(db, expected, ack.roster_version); revokeConnections(); finishDeparture();
      }
    } catch (error) { if (!stopping) appendLog(dataDir, 'membership_status_unconfirmed', { error: errorMessage(error) }); }
    finally { selfStatusBusy = false; }
  };
  // Existing lifecycle timers, not a second service: returning offline peers can
  // learn their own revocation without gaining access to a current member list.
  relayTimers.push(setInterval(() => { void checkSelfMembership(); }, STATUS_REFRESH_MS));
  void checkSelfMembership();

  const messages = (joined: Joined): ConversationMessages => {
    const self = findMember(joined.roster, machineId);
    if (!self) throw new Error('This machine is no longer a network member');
    return new ConversationMessages({ file: path.join(dataDir, 'messages.db'), busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS,
      network: { network_id: joined.config.network_id, self: { id: machineId, name: self.name },
        members: joined.roster.members.map(m => ({ id: m.machine_id, name: m.name })) } });
  };
  let lastPresenceAt = 0;
  const answer = async (frame: ConversationFrame, joined: Joined, remoteId: string): Promise<Ack> => {
    const member = findMember(joined.roster, remoteId);
    if (!member) return { result: 'rejected', code: 'not_a_member' };
    const store = messages(joined);
    try {
    if (frame.kind === 'conversations') {
      const firstContact = !peerRoute(db, remoteId);
      store.upsertRemoteRegistrations(remoteId, frame.entries);
      rememberPeer(db, remoteId, frame.relay, frame.addrs, Date.now());
      if (firstContact) lastPresenceAt = 0; // A machine heard from for the first time hears back on the next round, not in a minute.
      return { result: 'accepted' };
    }
    if (frame.kind === 'conversation-receipt') return { result: store.receiveReceipt(remoteId, frame.receipt) };
    const result = store.receiveFrom(remoteId, frame.row);
    if (result === 'accepted') {
      const message = store.status(frame.row.message.recipient, frame.row.message.id)[0]!;
      const wake = await wakeConversationMessage(message, store.wakeTarget(message.id), store.machine);
      if (wake.pushed) {
        authorize(remoteId);
        store.recordNetworkPush(remoteId, message.id, wake.route);
      }
    }
    return { result };
    } finally { store.close(); }
  };

  const answerMember = async (connection: Connection, remoteId: string): Promise<void> => {
    // Unknown transport identities may supply only a bounded owner-signed roster.
    const handshake = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, 'waiting for roster');
    await exchangeRosterStream(handshake, null, (offered) => {
      const selected = exchangeRoster(db, offered);
      revokeConnections();
      authorize(remoteId);
      return selected;
    }, STREAM_DEADLINE_MS);
    authorize(remoteId);
    memberConnections.set(connection, remoteId);
    try {
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
      const frame = parseConversationFrame(bytes);
      ack = await answer(frame, authorize(remoteId), remoteId);
      authorize(remoteId);
      appendLog(dataDir, 'frame_received', { machine_id: remoteId, frame: frame.kind, result: ack.result, code: ack.code ?? null });
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
    } finally { memberConnections.delete(connection); }
  };

  /** One frame to one member on its own stream; the answer, and whether it went through the relay. */
  const sendFrame = async (target: string, frame: ConversationFrame): Promise<{ ack: Ack; path: string | null }> => {
    parseConversationFrame(Buffer.from(JSON.stringify(frame)));
    const route = peerRoute(db, target);
    const relay = route?.relay ?? (relayUrl === RELAY_OFF ? null : relayUrl);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(target), relay, route?.addrs ?? []);
    const connection = await deadline(endpoint.connect(address, toBytes(NET_ALPN)), SEND_CONNECT_DEADLINE_MS, 'connecting to a member');
    try {
      const handshake = await deadline(connection.openBi(), STREAM_DEADLINE_MS, 'opening roster exchange');
      await exchangeRosterStream(handshake, signedRosterOf(joinedNow().config), (offered) => {
        const selected = exchangeRoster(db, offered);
        revokeConnections();
        authorize(target);
        return selected;
      }, STREAM_DEADLINE_MS);
      authorize(target);
      memberConnections.set(connection, target);
      const stream = await deadline(connection.openBi(), STREAM_DEADLINE_MS, 'opening a stream');
      const fresh = messages(authorize(target));
      try {
        // A roster/network may have changed while connecting: an old selected
        // row must never cross into a newly joined network sharing the peer key.
        if (frame.kind === 'conversation-message'
          && !fresh.outgoingFor(target).some(row => JSON.stringify(row) === JSON.stringify(frame.row))) throw new Error('Outgoing network binding changed');
        if (frame.kind === 'conversation-receipt'
          && !fresh.receiptsFor(target).some(receipt => JSON.stringify(receipt) === JSON.stringify(frame.receipt))) throw new Error('Receipt network binding changed');
      } finally { fresh.close(); }
      await deadline(stream.send.writeAll(toBytes(JSON.stringify(frame))), STREAM_DEADLINE_MS, 'sending a frame');
      await deadline(stream.send.finish(), STREAM_DEADLINE_MS, 'sending a frame');
      const ack = parseAck(Buffer.from(await deadline(stream.recv.readToEnd(ACK_MAX_BYTES), STREAM_DEADLINE_MS, 'waiting for the answer')));
      authorize(target);
      let path: string | null = null;
      try {
        const selected = connection.paths().find((candidate) => candidate.isSelected);
        path = selected ? (selected.isRelay ? 'relay' : 'direct') : null;
      } catch { /* the path is informational */ }
      return { ack, path };
    } finally {
      memberConnections.delete(connection);
      connection.close(0n, toBytes('done'));
    }
  };

  let courierBusy = false;
  // Each machine is handled on its own: a member that does not answer costs its own
  // connect deadline, never another member's message or presence.
  const sendingTo = new Set<string>();
  const announcingTo = new Set<string>();
  /** One machine's due messages, in order; stops at the first it cannot reach. */
  const deliverTo = async (target: string): Promise<void> => {
    sendingTo.add(target);
    try {
      const before = messages(authorize(target));
      let outgoing; let receipts;
      try { outgoing = before.outgoingFor(target); receipts = before.receiptsFor(target); } finally { before.close(); }
      for (const row of outgoing) {
        if (stopping) return;
        const { ack } = await sendFrame(target, { version: 2, kind: 'conversation-message', row });
        if (ack.result !== 'accepted' && ack.result !== 'duplicate') {
          appendLog(dataDir, 'message_not_accepted', { message_id: row.message.id, result: ack.result, code: ack.code ?? null });
          return;
        }
        const current = messages(authorize(target));
        try { current.recordCopyAccepted(target, row.message.id); } finally { current.close(); }
      }
      for (const receipt of receipts) {
        if (stopping) return;
        const { ack } = await sendFrame(target, { version: 2, kind: 'conversation-receipt', receipt });
        if (ack.result !== 'accepted' && ack.result !== 'duplicate') return;
        const current = messages(authorize(target));
        try { current.recordReceiptAccepted(target, receipt); } finally { current.close(); }
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
    const store = messages(joined);
    let frames: ConversationFrame[];
    try { frames = conversationPresenceFrames(relayUrl === RELAY_OFF ? null : relayUrl, advertisedAddresses(endpoint), store.exportRegistrations()); }
    finally { store.close(); }
    const content = JSON.stringify(frames);
    for (const member of joined.roster.members) {
      const target = member.machine_id;
      if (target === machineId || announcingTo.has(target)) continue;
      if (!heartbeat && sentTo.get(target) === content) continue; // Nothing new for it.
      if (!peerRoute(db, target) && relayUrl === RELAY_OFF) continue; // No way to reach it yet.
      announcingTo.add(target);
      void (async () => {
        for (const frame of frames) {
          if (stopping) return;
          const { ack } = await sendFrame(target, frame);
          if (ack.result !== 'accepted') throw new Error('Presence not accepted');
        }
        sentTo.set(target, content);
      })()
        .catch((err: unknown) => { if (!stopping) appendLog(dataDir, 'presence_unreachable', { machine_id: target, error: errorMessage(err) }); })
        .finally(() => { announcingTo.delete(target); });
    }
  };
  /** Forward what is waiting, expire what has waited too long, and say who is live here. */
  const courier = async (): Promise<void> => {
    if (courierBusy || stopping) return;
    courierBusy = true;
    try {
      revokeConnections();
      const joined = joinedNow();
      // NET/2 can also persist a verified owner-signed removal before denying
      // business access. Honor that removal even while the owner is offline.
      if (!findMember(joined.roster, machineId)) {
        clearMembership(db, joined.config, joined.roster.version);
        revokeConnections(); finishDeparture(); return;
      }
      const now = Date.now();
      const store = messages(joined);
      try { store.maintainMessages(); } finally { store.close(); }
      // Started, not awaited: each machine runs on its own, at most one run each at a time.
      for (const member of joined.roster.members) {
        const target = member.machine_id;
        if (target !== machineId && !sendingTo.has(target)) void deliverTo(target);
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
      else if (alpn === MEMBERSHIP_ALPN) await answerMembership(connection, remoteId);
      else {
        connection.close(2n, toBytes('unknown_protocol'));
        appendLog(dataDir, 'unknown_protocol_refused', { machine_id: remoteId });
      }
    } catch (err) {
      recordError('connection_failed', errorMessage(err));
      const notMember = errorMessage(err) === 'not_a_member';
      if (notMember) { status.non_member_refused++; publish(); }
      try { connection?.close(3n, toBytes(notMember ? 'not_a_member' : 'error')); } catch { /* already closed */ }
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
