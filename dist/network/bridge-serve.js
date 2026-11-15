import fs from 'node:fs';
import path from 'node:path';
import { ConversationMessages } from '../core/conversation-messages.js';
import { assertLegacyPathsAreDifferent } from '../core/conversation-message-migration.js';
import { getDbPath } from '../core/paths.js';
import { wakeConversationMessage } from '../host-adapters/conversation-wake.js';
import { logPath, writeStatus } from './bridge-state.js';
import { holdControlSocket } from './control-socket.js';
import { advertisedAddresses, bindEndpoint, deadline, toBytes } from './endpoint.js';
import { ensureNetworkDir, loadIdentity } from './identity.js';
import { JOIN_REQUEST_MAX_BYTES, handleJoinRequest } from './join-protocol.js';
import { explainLoadFailure, loadNative } from './native-loader.js';
import { RELAY_PING_INTERVAL_MS, applyRelayState, pingRelay, relayComplaint } from './relay-monitor.js';
import { findMember, verifyRoster } from './roster.js';
import { appendTestFrameLog } from './test-frame-log.js';
import { peerRoute, rememberPeer, } from './courier.js';
import { ACK_MAX_BYTES, FRAME_MAX_BYTES, FrameError, parseAck, exchangeRosterStream, parseConversationFrame, conversationPresenceFrames, } from './frames.js';
import { authorizeNetworkPeer, exchangeRoster, openNetworkStore, readConfig, signedRosterOf } from './store.js';
import { EXIT_ALREADY_RUNNING, EXIT_HOLDER_UNRESPONSIVE, JOIN_ALPN, NET_ALPN, RELAY_OFF, errorMessage, runtimeDir, } from './types.js';
const RELAY_ONLINE_DEADLINE_MS = 20_000;
const HANDSHAKE_DEADLINE_MS = 20_000;
const STREAM_DEADLINE_MS = 15_000;
const CLOSE_DEADLINE_MS = 5_000;
export const BRIDGE_BUSY_TIMEOUT_MS = 3_000;
const HEARTBEAT_MS = 1_000;
const STATUS_REFRESH_MS = 30_000;
const SOCKET_UNREADABLE_LIMIT_MS = 30_000;
const LOG_MAX_BYTES = 1024 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 32;
const COURIER_INTERVAL_MS = 1_000;
const PRESENCE_INTERVAL_MS = 60_000;
const SEND_CONNECT_DEADLINE_MS = 20_000;
function appendLog(dataDir, event, detail = {}) {
    try {
        const file = logPath(dataDir);
        if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES)
            fs.renameSync(file, `${file}.1`);
        fs.appendFileSync(file, line(event, detail), { mode: 0o600 });
    }
    catch {
        try {
            process.stderr.write(line(event, detail));
        }
        catch { }
    }
}
function line(event, detail) {
    return `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail })}\n`;
}
export async function serve(dataDir, dbPath) {
    assertLegacyPathsAreDifferent(getDbPath(), path.join(dataDir, 'messages.db'));
    assertLegacyPathsAreDifferent(getDbPath(), dbPath);
    try {
        process.umask(0o077);
    }
    catch { }
    ensureNetworkDir(dataDir);
    let requestStop = () => {
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
    const status = {
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
    const publish = () => {
        if (control.ownership() === 'lost')
            return;
        status.updated_at = new Date().toISOString();
        try {
            writeStatus(dataDir, status);
        }
        catch (err) {
            appendLog(dataDir, 'status_write_failed', { error: errorMessage(err) });
        }
    };
    const recordError = (event, message) => {
        status.last_error = message;
        status.last_error_at = new Date().toISOString();
        appendLog(dataDir, event, { error: message });
        publish();
    };
    const fail = (event, message) => {
        status.state = 'failed';
        recordError(event, message);
        control.close();
        return 1;
    };
    publish();
    let db;
    let config;
    try {
        db = openNetworkStore(dbPath, { busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS, metadataOnly: true });
        config = readConfig(db);
    }
    catch (err) {
        return fail('exit_database', `Cannot open the database: ${errorMessage(err)}`);
    }
    if (!config) {
        db.close();
        return fail('exit_not_joined', 'This machine has not joined a network.');
    }
    const { machine_id: machineId, owner_id: ownerId, relay_url: relayUrl } = config;
    const isOwner = ownerId === machineId;
    let identity;
    try {
        identity = loadIdentity(dataDir);
    }
    catch (err) {
        db.close();
        return fail('exit_identity', errorMessage(err));
    }
    if (identity.machineId !== machineId) {
        db.close();
        return fail('exit_identity', 'The machine key does not match the one this network was joined with.');
    }
    let iroh;
    try {
        iroh = loadNative(runtimeDir(dataDir));
    }
    catch (err) {
        db.close();
        return fail('exit_native', `Cannot load the networking component: ${explainLoadFailure(err)}`);
    }
    let endpoint;
    try {
        endpoint = await bindEndpoint(iroh, identity.secret, relayUrl, isOwner ? [JOIN_ALPN, NET_ALPN] : [NET_ALPN]);
    }
    catch (err) {
        db.close();
        return fail('exit_bind', `Cannot open a network connection: ${errorMessage(err)}`);
    }
    status.state = 'running';
    ready = true;
    status.relay_state = relayUrl === RELAY_OFF ? 'off' : 'connecting';
    publish();
    appendLog(dataDir, 'running', { relay_state: status.relay_state, owner: isOwner });
    const relaySignals = { online: false, deadlinePassed: false, reachable: null };
    const refreshRelayState = () => {
        if (!applyRelayState(status, relaySignals, relayUrl))
            return;
        appendLog(dataDir, 'relay_state', { relay_state: status.relay_state });
        if (status.relay_state === 'unreachable')
            recordError('relay_unreachable', relayComplaint(relayUrl));
        else
            publish();
    };
    const relayTimers = [];
    if (status.relay_state === 'connecting') {
        endpoint.online().then(() => {
            relaySignals.online = true;
            refreshRelayState();
        }, (err) => {
            recordError('relay_failed', `The relay failed: ${errorMessage(err)}`);
        });
        relayTimers.push(setTimeout(() => {
            relaySignals.deadlinePassed = true;
            refreshRelayState();
        }, RELAY_ONLINE_DEADLINE_MS));
        let pingInFlight = false;
        const ping = () => {
            if (pingInFlight)
                return;
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
    let lastPublished = Date.now();
    let unreadableSince = null;
    const heartbeat = setInterval(() => {
        const ownership = control.ownership();
        if (ownership === 'lost') {
            void abandon();
            return;
        }
        if (ownership === 'unreadable') {
            if (unreadableSince === null) {
                unreadableSince = Date.now();
                appendLog(dataDir, 'control_socket_unreadable_retrying');
            }
            else if (Date.now() - unreadableSince >= SOCKET_UNREADABLE_LIMIT_MS) {
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
        let addresses = null;
        try {
            addresses = advertisedAddresses(endpoint);
        }
        catch (err) {
            appendLog(dataDir, 'addresses_failed', { error: errorMessage(err) });
        }
        const changed = addresses !== null && addresses.join() !== status.direct_addresses.join();
        if (changed)
            status.direct_addresses = addresses;
        if (changed || Date.now() - lastPublished >= STATUS_REFRESH_MS) {
            lastPublished = Date.now();
            publish();
        }
    }, HEARTBEAT_MS);
    let stopping = false;
    const stop = async (reason, exitCode) => {
        if (stopping)
            await new Promise(() => { });
        stopping = true;
        clearInterval(heartbeat);
        relayTimers.forEach(clearTimeout);
        try {
            await deadline(endpoint.close(), CLOSE_DEADLINE_MS, 'closing the endpoint');
        }
        catch (err) {
            appendLog(dataDir, 'close_failed', { error: errorMessage(err) });
        }
        status.state = exitCode === 0 ? 'stopped' : 'failed';
        appendLog(dataDir, 'stopped', { reason });
        publish();
        try {
            db.close();
        }
        catch { }
        control.close();
        process.exit(exitCode);
    };
    const abandon = async () => {
        if (stopping)
            return;
        stopping = true;
        clearInterval(heartbeat);
        relayTimers.forEach(clearTimeout);
        appendLog(dataDir, 'control_socket_lost', { detail: 'The control socket path is gone or replaced, so this bridge is exiting.' });
        await deadline(endpoint.close(), CLOSE_DEADLINE_MS, 'closing the endpoint').catch(() => undefined);
        try {
            db.close();
        }
        catch { }
        process.exit(1);
    };
    requestStop = () => { void stop('asked over the control socket', 0); };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
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
    const finishConnection = async (connection) => {
        await deadline(connection.closed(), CLOSE_DEADLINE_MS, 'waiting for the peer to close').catch(() => undefined);
        connection.close(0n, toBytes('done'));
    };
    const answerJoin = async (connection, remoteId) => {
        const stream = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, 'waiting for the join request');
        const request = Buffer.from(await deadline(stream.recv.readToEnd(JOIN_REQUEST_MAX_BYTES), STREAM_DEADLINE_MS, 'reading the join request'));
        let reply;
        try {
            reply = handleJoinRequest(db, identity, remoteId, request, Date.now());
        }
        catch (err) {
            recordError('join_failed', errorMessage(err));
            reply = { ok: false, error: 'internal' };
        }
        if (reply.ok) {
            status.joins_accepted++;
            appendLog(dataDir, 'join_accepted', { machine_id: remoteId });
        }
        else {
            status.joins_refused++;
            appendLog(dataDir, 'join_refused', { machine_id: remoteId, reason: reply.error });
        }
        publish();
        await deadline(stream.send.writeAll(toBytes(JSON.stringify(reply))), STREAM_DEADLINE_MS, 'sending the join reply');
        await stream.send.finish();
        await finishConnection(connection);
    };
    const joinedNow = () => {
        const current = readConfig(db);
        if (!current)
            throw new Error('The network settings are gone from the database.');
        return { config: current, roster: verifyRoster(signedRosterOf(current), ownerId, current.network_id) };
    };
    const memberConnections = new Map();
    const authorize = (remoteId) => {
        authorizeNetworkPeer(db, remoteId);
        return joinedNow();
    };
    const revokeConnections = () => {
        for (const [connection, remoteId] of memberConnections) {
            try {
                authorize(remoteId);
            }
            catch {
                connection.close(1n, toBytes('not_a_member'));
                memberConnections.delete(connection);
            }
        }
    };
    const messages = (joined) => {
        const self = findMember(joined.roster, machineId);
        if (!self)
            throw new Error('This machine is no longer a network member');
        return new ConversationMessages({ file: path.join(dataDir, 'messages.db'), busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS,
            network: { network_id: joined.config.network_id, self: { id: machineId, name: self.name },
                members: joined.roster.members.map(m => ({ id: m.machine_id, name: m.name })) } });
    };
    let lastPresenceAt = 0;
    const answer = async (frame, joined, remoteId) => {
        const member = findMember(joined.roster, remoteId);
        if (!member)
            return { result: 'rejected', code: 'not_a_member' };
        const store = messages(joined);
        try {
            if (frame.kind === 'conversations') {
                const firstContact = !peerRoute(db, remoteId);
                store.upsertRemoteRegistrations(remoteId, frame.entries);
                rememberPeer(db, remoteId, frame.relay, frame.addrs, Date.now());
                if (firstContact)
                    lastPresenceAt = 0;
                return { result: 'accepted' };
            }
            if (frame.kind === 'conversation-receipt')
                return { result: store.receiveReceipt(remoteId, frame.receipt) };
            const result = store.receiveFrom(remoteId, frame.row);
            if (result === 'accepted') {
                const message = store.status(frame.row.message.recipient, frame.row.message.id)[0];
                const wake = await wakeConversationMessage(message, store.wakeTarget(message.id), store.machine);
                if (wake.pushed) {
                    authorize(remoteId);
                    store.recordNetworkPush(remoteId, message.id, wake.route);
                }
            }
            return { result };
        }
        finally {
            store.close();
        }
    };
    const answerMember = async (connection, remoteId) => {
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
            const frameLog = process.env.MEMESH_TEST_NETWORK_FRAME_LOG;
            if (frameLog) {
                const refused = appendTestFrameLog(frameLog, bytes);
                if (refused)
                    recordError('test_frame_log_refused', refused);
            }
            let ack;
            try {
                const frame = parseConversationFrame(bytes);
                ack = await answer(frame, authorize(remoteId), remoteId);
                authorize(remoteId);
                appendLog(dataDir, 'frame_received', { machine_id: remoteId, frame: frame.kind, result: ack.result, code: ack.code ?? null });
            }
            catch (err) {
                if (err instanceof FrameError)
                    ack = { result: 'rejected', code: err.code };
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
        }
        finally {
            memberConnections.delete(connection);
        }
    };
    const sendFrame = async (target, frame) => {
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
                if (frame.kind === 'conversation-message'
                    && !fresh.outgoingFor(target).some(row => JSON.stringify(row) === JSON.stringify(frame.row)))
                    throw new Error('Outgoing network binding changed');
                if (frame.kind === 'conversation-receipt'
                    && !fresh.receiptsFor(target).some(receipt => JSON.stringify(receipt) === JSON.stringify(frame.receipt)))
                    throw new Error('Receipt network binding changed');
            }
            finally {
                fresh.close();
            }
            await deadline(stream.send.writeAll(toBytes(JSON.stringify(frame))), STREAM_DEADLINE_MS, 'sending a frame');
            await deadline(stream.send.finish(), STREAM_DEADLINE_MS, 'sending a frame');
            const ack = parseAck(Buffer.from(await deadline(stream.recv.readToEnd(ACK_MAX_BYTES), STREAM_DEADLINE_MS, 'waiting for the answer')));
            authorize(target);
            let path = null;
            try {
                const selected = connection.paths().find((candidate) => candidate.isSelected);
                path = selected ? (selected.isRelay ? 'relay' : 'direct') : null;
            }
            catch { }
            return { ack, path };
        }
        finally {
            memberConnections.delete(connection);
            connection.close(0n, toBytes('done'));
        }
    };
    let courierBusy = false;
    const sendingTo = new Set();
    const announcingTo = new Set();
    const deliverTo = async (target) => {
        sendingTo.add(target);
        try {
            const before = messages(authorize(target));
            let outgoing;
            let receipts;
            try {
                outgoing = before.outgoingFor(target);
                receipts = before.receiptsFor(target);
            }
            finally {
                before.close();
            }
            for (const row of outgoing) {
                if (stopping)
                    return;
                const { ack } = await sendFrame(target, { version: 2, kind: 'conversation-message', row });
                if (ack.result !== 'accepted' && ack.result !== 'duplicate') {
                    appendLog(dataDir, 'message_not_accepted', { message_id: row.message.id, result: ack.result, code: ack.code ?? null });
                    return;
                }
                const current = messages(authorize(target));
                try {
                    current.recordCopyAccepted(target, row.message.id);
                }
                finally {
                    current.close();
                }
            }
            for (const receipt of receipts) {
                if (stopping)
                    return;
                const { ack } = await sendFrame(target, { version: 2, kind: 'conversation-receipt', receipt });
                if (ack.result !== 'accepted' && ack.result !== 'duplicate')
                    return;
                const current = messages(authorize(target));
                try {
                    current.recordReceiptAccepted(target, receipt);
                }
                finally {
                    current.close();
                }
            }
        }
        catch (err) {
            if (!stopping)
                recordError('courier_failed', errorMessage(err));
        }
        finally {
            sendingTo.delete(target);
        }
    };
    const sentTo = new Map();
    const announce = (joined, heartbeat) => {
        const store = messages(joined);
        let frames;
        try {
            frames = conversationPresenceFrames(relayUrl === RELAY_OFF ? null : relayUrl, advertisedAddresses(endpoint), store.exportRegistrations());
        }
        finally {
            store.close();
        }
        const content = JSON.stringify(frames);
        for (const member of joined.roster.members) {
            const target = member.machine_id;
            if (target === machineId || announcingTo.has(target))
                continue;
            if (!heartbeat && sentTo.get(target) === content)
                continue;
            if (!peerRoute(db, target) && relayUrl === RELAY_OFF)
                continue;
            announcingTo.add(target);
            void (async () => {
                for (const frame of frames) {
                    if (stopping)
                        return;
                    const { ack } = await sendFrame(target, frame);
                    if (ack.result !== 'accepted')
                        throw new Error('Presence not accepted');
                }
                sentTo.set(target, content);
            })()
                .catch((err) => { if (!stopping)
                appendLog(dataDir, 'presence_unreachable', { machine_id: target, error: errorMessage(err) }); })
                .finally(() => { announcingTo.delete(target); });
        }
    };
    const courier = async () => {
        if (courierBusy || stopping)
            return;
        courierBusy = true;
        try {
            revokeConnections();
            const joined = joinedNow();
            const now = Date.now();
            const store = messages(joined);
            try {
                store.maintainMessages();
            }
            finally {
                store.close();
            }
            for (const member of joined.roster.members) {
                const target = member.machine_id;
                if (target !== machineId && !sendingTo.has(target))
                    void deliverTo(target);
            }
            const heartbeat = now - lastPresenceAt >= PRESENCE_INTERVAL_MS;
            if (heartbeat)
                lastPresenceAt = now;
            announce(joined, heartbeat);
        }
        catch (err) {
            recordError('courier_failed', errorMessage(err));
        }
        finally {
            courierBusy = false;
        }
    };
    relayTimers.push(setInterval(() => { void courier(); }, COURIER_INTERVAL_MS));
    void courier();
    const handleIncoming = async (incoming) => {
        let connection;
        try {
            const accepting = await deadline(incoming.accept(), HANDSHAKE_DEADLINE_MS, 'accepting a connection');
            connection = await deadline(accepting.connect(), HANDSHAKE_DEADLINE_MS, 'the connection handshake');
            const remoteId = connection.remoteId().toString();
            const alpn = Buffer.from(connection.alpn()).toString();
            if (alpn === JOIN_ALPN && isOwner)
                await answerJoin(connection, remoteId);
            else if (alpn === NET_ALPN)
                await answerMember(connection, remoteId);
            else {
                connection.close(2n, toBytes('unknown_protocol'));
                appendLog(dataDir, 'unknown_protocol_refused', { machine_id: remoteId });
            }
        }
        catch (err) {
            recordError('connection_failed', errorMessage(err));
            try {
                connection?.close(3n, toBytes('error'));
            }
            catch { }
        }
    };
    let inFlight = 0;
    for (;;) {
        let incoming;
        try {
            incoming = await endpoint.acceptNext();
        }
        catch (err) {
            recordError('accept_failed', errorMessage(err));
            return stop('accept_failed', 1);
        }
        if (incoming === null)
            return stop('endpoint_closed', stopping ? 0 : 1);
        if (inFlight >= MAX_CONCURRENT_CONNECTIONS) {
            appendLog(dataDir, 'too_many_connections_refused');
            void incoming.refuse().catch((err) => appendLog(dataDir, 'refuse_failed', { error: errorMessage(err) }));
            continue;
        }
        inFlight++;
        void handleIncoming(incoming).finally(() => { inFlight--; });
    }
}
//# sourceMappingURL=bridge-serve.js.map