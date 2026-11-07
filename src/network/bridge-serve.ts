// The long-running bridge. Holds the data dir's pid lock, answers joins when this
// machine owns the network, and enforces membership on memesh/net/1. Every refusal
// and every early exit leaves a record: a background process that fails quietly
// looks exactly like one that is working.

import fs from 'node:fs';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { logPath, writeStatus, type BridgeStatus } from './bridge-state.js';
import { holdControlSocket } from './control-socket.js';
import { bindEndpoint, deadline, toBytes } from './endpoint.js';
import { ensureNetworkDir, loadIdentity, type Identity } from './identity.js';
import type { Connection, Endpoint, Incoming, IrohModule } from './iroh-types.js';
import { JOIN_REQUEST_MAX_BYTES, handleJoinRequest, type JoinReply } from './join-protocol.js';
import { explainLoadFailure, loadNative } from './native-loader.js';
import { RELAY_PING_INTERVAL_MS, applyRelayState, pingRelay, relayComplaint, type RelaySignals } from './relay-monitor.js';
import { findMember, verifyRoster } from './roster.js';
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
const MEMBER_STUB_MAX_BYTES = 1024;
const MEMBER_STUB_REPLY = JSON.stringify({ ok: false, error: 'not_implemented' });

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
    member_stub_served: 0,
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
      addresses = endpoint.addr().directAddresses();
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

  /** Slice stub: membership is enforced here for real; carrying messages comes later. */
  const answerMember = async (connection: Connection, remoteId: string): Promise<void> => {
    // Read fresh for every connection, so a machine that just joined is let in.
    // Verified like any roster: a list whose signature does not check out admits nobody.
    const current = readConfig(db);
    if (!current) throw new Error('The network settings are gone from the database.');
    const roster = verifyRoster(signedRosterOf(current), ownerId, current.network_id);
    if (!findMember(roster, remoteId)) {
      connection.close(1n, toBytes('not_a_member'));
      status.non_member_refused++;
      appendLog(dataDir, 'non_member_refused', { machine_id: remoteId });
      publish();
      return;
    }
    const stream = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, 'waiting for a member stream');
    await deadline(stream.recv.readToEnd(MEMBER_STUB_MAX_BYTES), STREAM_DEADLINE_MS, 'reading a member stream');
    await deadline(stream.send.writeAll(toBytes(MEMBER_STUB_REPLY)), STREAM_DEADLINE_MS, 'answering a member');
    await stream.send.finish();
    status.member_stub_served++;
    appendLog(dataDir, 'member_stub_served', { machine_id: remoteId });
    publish();
    await finishConnection(connection);
  };

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
