import fs from 'node:fs';
import path from 'node:path';
import { ConversationMessages } from '../core/conversation-messages.js';
import { assertLegacyPathsAreDifferent } from '../core/conversation-message-migration.js';
import { getDbPath } from '../core/paths.js';
import { wakeConversationMessage } from '../host-adapters/conversation-wake.js';
import { logPath, readStatus, restartBindAddresses, writeStatus } from './bridge-state.js';
import { holdControlSocket } from './control-socket.js';
import { MEMBERSHIP_MAX_BYTES, MEMBERSHIP_ACK_MAX_BYTES, MEMBERSHIP_DEADLINE_MS, parseMembershipFrame, parseMembershipAck, membershipConfig, removeMember, clearMembership, receiveMembershipRoster, } from './membership.js';
import { advertisedAddresses, bindEndpoint, deadline, toBytes } from './endpoint.js';
import { ensureNetworkDir, loadIdentity } from './identity.js';
import { JOIN_REQUEST_MAX_BYTES, handleJoinRequest } from './join-protocol.js';
import { explainLoadFailure, loadNative } from './native-loader.js';
import { RELAY_PING_INTERVAL_MS, applyRelayState, pingRelay, relayComplaint } from './relay-monitor.js';
import { findMember, verifyRoster } from './roster.js';
import { appendTestFrameLog } from './test-frame-log.js';
import { peerRoute, rememberPeer, memberRoutes, receivePeerRoutes, } from './courier.js';
import { ACK_MAX_BYTES, FRAME_MAX_BYTES, FrameError, parseAck, exchangeRosterStream, parseConversationFrame, conversationPresenceFrames, peerRouteFrames, } from './frames.js';
import { authorizeNetworkPeer, exchangeRoster, openNetworkStore, readConfig, signedRosterOf } from './store.js';
import { EXIT_ALREADY_RUNNING, EXIT_HOLDER_UNRESPONSIVE, JOIN_ALPN, NET_ALPN, MEMBERSHIP_ALPN, RELAY_OFF, errorMessage, runtimeDir, } from './types.js';
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
    const status = {
        pid: process.pid,
        started_at: startedAt,
        updated_at: startedAt,
        state: 'starting',
        relay_state: 'off',
        last_error: null,
        last_error_at: null,
        direct_addresses: [],
        bind_addresses: restartBindAddresses(readStatus(dataDir)),
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
        db = openNetworkStore(dbPath, { busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS });
        config = readConfig(db);
    }
    catch (err) {
        return fail('exit_database', `Cannot open the database: ${errorMessage(err)}`);
    }
    if (!config) {
        db.close();
        return fail('exit_not_joined', 'This machine has not joined a network.');
    }
    const { machine_id: machineId, owner_id: ownerId, relay_url: relayUrl, network_id: networkId } = config;
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
        const savedAddresses = relayUrl === RELAY_OFF ? status.bind_addresses ?? [] : [];
        const rebindUntil = Date.now() + HEARTBEAT_MS + CLOSE_DEADLINE_MS;
        for (;;) {
            if (!control.stillOurs())
                throw new Error('Control socket ownership was lost before binding');
            try {
                endpoint = await bindEndpoint(iroh, identity.secret, relayUrl, isOwner ? [JOIN_ALPN, NET_ALPN, MEMBERSHIP_ALPN] : [NET_ALPN, MEMBERSHIP_ALPN], process.env, savedAddresses);
                if (!control.stillOurs()) {
                    await deadline(endpoint.close(), CLOSE_DEADLINE_MS, 'closing a displaced endpoint');
                    throw new Error('Control socket ownership was lost while binding');
                }
                break;
            }
            catch (err) {
                if (!savedAddresses.length || !/address already in use/i.test(errorMessage(err))
                    || Date.now() >= rebindUntil || !control.stillOurs())
                    throw err;
                await new Promise(resolve => setTimeout(resolve, 250));
                if (Date.now() >= rebindUntil)
                    throw err;
            }
        }
        status.bind_addresses = endpoint.boundSockets();
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
        if (current.network_id !== networkId || current.owner_id !== ownerId || current.machine_id !== machineId)
            throw new Error('Bridge network identity changed');
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
    let lastMessageStoreOpen;
    const requestMembership = async (target, frame, expected) => {
        const until = Date.now() + MEMBERSHIP_DEADLINE_MS;
        const started = performance.now();
        const elapsed = () => Math.round(performance.now() - started);
        const remaining = () => Math.max(1, until - Date.now());
        parseMembershipFrame(Buffer.from(JSON.stringify(frame)));
        membershipConfig(db, expected);
        const route = peerRoute(db, target);
        const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(target), route?.relay ?? (relayUrl === RELAY_OFF ? null : relayUrl), route?.addrs ?? []);
        let expired = false;
        let connection;
        let connectedMs;
        let openedMs;
        let writtenMs;
        let finishedMs;
        let readMs;
        const preparedMs = elapsed();
        const pending = endpoint.connect(address, toBytes(MEMBERSHIP_ALPN));
        void pending.then(c => { if (expired)
            c.close(1n, toBytes('management_timeout')); }, () => undefined);
        try {
            connection = await deadline(pending, remaining(), 'connecting for membership');
            connectedMs = elapsed();
            if (connection.remoteId().toString() !== target)
                throw new Error('Wrong membership peer');
            membershipConfig(db, expected);
            const stream = await deadline(connection.openBi(), remaining(), 'opening membership request');
            openedMs = elapsed();
            await deadline(stream.send.writeAll(toBytes(JSON.stringify(frame))), remaining(), 'sending membership request');
            writtenMs = elapsed();
            await deadline(stream.send.finish(), remaining(), 'finishing membership request');
            finishedMs = elapsed();
            const bytes = await deadline(stream.recv.readToEnd(MEMBERSHIP_ACK_MAX_BYTES), remaining(), 'receiving membership confirmation');
            readMs = elapsed();
            return parseMembershipAck(Buffer.from(bytes), expected.network_id);
        }
        catch (error) {
            const store = lastMessageStoreOpen;
            appendLog(dataDir, 'membership_request_failed', {
                op: frame.op, elapsedMs: elapsed(), remainingMs: Math.max(0, until - Date.now()),
                preparedMs, connectedMs, openedMs, writtenMs, finishedMs, readMs,
                messageStoreStartedMs: store && Math.round(store.started - started),
                messageStoreCompletedMs: store && Math.round(store.finished - started),
                messageStoreElapsedMs: store && Math.round(store.finished - store.started),
            });
            throw error;
        }
        finally {
            expired = true;
            connection?.close(0n, toBytes('membership_done'));
        }
    };
    const finishDeparture = () => {
        if (!stopping && control.stillOurs() && readConfig(db) === null) {
            status.membership_departure = { network_id: networkId, owner_id: ownerId, machine_id: machineId };
            void stop('membership revoked', 0);
        }
    };
    const broadcastRoster = async (expected, signed, targets, skip) => {
        const todo = [...new Set(targets)].filter(id => id !== machineId && id !== skip);
        const unsynchronized = [];
        const until = Date.now() + 15_000;
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
            for (;;) {
                const target = todo[next++];
                if (!target)
                    return;
                if (Date.now() >= until || stopping) {
                    unsynchronized.push(target);
                    continue;
                }
                try {
                    const ack = await requestMembership(target, { version: 1, op: 'roster', network_id: expected.network_id, roster: signed }, expected);
                    if (ack.roster_version < verifyRoster(signed, expected.owner_id, expected.network_id).version)
                        throw new Error('Roster not acknowledged');
                }
                catch {
                    unsynchronized.push(target);
                }
            }
        }));
        return unsynchronized.sort();
    };
    let membershipBusy = false;
    const membershipAction = async (action) => {
        if (membershipBusy || stopping || !control.stillOurs())
            throw new Error('Membership action unavailable');
        membershipBusy = true;
        try {
            const expected = joinedNow().config;
            if (action.network_id !== expected.network_id || action.machine_id !== expected.machine_id)
                throw new Error('Membership control binding changed');
            if (action.action === 'remove') {
                const changed = removeMember(db, identity, expected, action.target);
                revokeConnections();
                const unsynchronized = await broadcastRoster(expected, changed.signed, [...changed.priorMembers, changed.removed]);
                return { result: { action: 'remove', network_id: expected.network_id, roster_version: verifyRoster(changed.signed, ownerId, expected.network_id).version,
                        removed: changed.removed, already_removed: changed.alreadyRemoved, unsynchronized } };
            }
            if (isOwner)
                throw new Error('Owner departure is not supported; no membership was changed.');
            const ack = await requestMembership(ownerId, { version: 1, op: 'leave-self', network_id: expected.network_id }, expected);
            if (ack.member || ack.roster_version < verifyRoster(signedRosterOf(expected), ownerId, expected.network_id).version)
                throw new Error('Owner has not confirmed departure');
            if (stopping || !control.stillOurs())
                throw new Error('Bridge changed before departure confirmation');
            clearMembership(db, expected, ack.roster_version);
            revokeConnections();
            return { result: { action: 'leave', network_id: expected.network_id, roster_version: ack.roster_version,
                    removed: machineId, already_removed: false, unsynchronized: null }, afterReply: finishDeparture };
        }
        finally {
            membershipBusy = false;
        }
    };
    const answerMembership = async (connection, remoteId) => {
        const entered = performance.now();
        const elapsed = () => Math.round(performance.now() - entered);
        let op;
        let acceptedMs;
        let readMs;
        let appliedMs;
        let ackMs;
        try {
            const stream = await deadline(connection.acceptBi(), MEMBERSHIP_DEADLINE_MS, 'waiting for membership request');
            acceptedMs = elapsed();
            const bytes = await deadline(stream.recv.readToEnd(MEMBERSHIP_MAX_BYTES), MEMBERSHIP_DEADLINE_MS, 'reading membership request');
            readMs = elapsed();
            const frame = parseMembershipFrame(Buffer.from(bytes));
            op = frame.op;
            const expected = joinedNow().config;
            if (frame.network_id !== expected.network_id)
                throw new Error('Wrong membership network');
            let ack;
            let departed = false;
            if (frame.op === 'roster') {
                if (remoteId !== expected.owner_id)
                    throw new Error('Only the owner may push membership');
                const accepted = receiveMembershipRoster(db, expected, frame.roster);
                revokeConnections();
                departed = !accepted.member;
                ack = { version: 1, network_id: expected.network_id, roster_version: accepted.version, member: accepted.member };
            }
            else {
                if (!isOwner || identity.machineId !== expected.owner_id)
                    throw new Error('Membership request requires the owner');
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
            appliedMs = elapsed();
            try {
                await deadline(stream.send.writeAll(toBytes(JSON.stringify(ack))), MEMBERSHIP_DEADLINE_MS, 'answering membership');
                await deadline(stream.send.finish(), MEMBERSHIP_DEADLINE_MS, 'finishing membership answer');
                ackMs = elapsed();
                await finishConnection(connection);
            }
            finally {
                if (departed)
                    finishDeparture();
            }
        }
        finally {
            appendLog(dataDir, 'membership_response_timing', { op, elapsedMs: elapsed(), acceptedMs, readMs, appliedMs, ackMs });
        }
    };
    let selfStatusBusy = false;
    const checkSelfMembership = async () => {
        if (isOwner || selfStatusBusy || stopping)
            return;
        selfStatusBusy = true;
        try {
            const expected = joinedNow().config;
            const ack = await requestMembership(ownerId, { version: 1, op: 'self-status', network_id: expected.network_id }, expected);
            if (!ack.member && ack.roster_version >= verifyRoster(signedRosterOf(expected), ownerId, expected.network_id).version) {
                if (stopping || !control.stillOurs())
                    return;
                clearMembership(db, expected, ack.roster_version);
                revokeConnections();
                finishDeparture();
            }
        }
        catch (error) {
            if (!stopping)
                appendLog(dataDir, 'membership_status_unconfirmed', { error: errorMessage(error) });
        }
        finally {
            selfStatusBusy = false;
        }
    };
    relayTimers.push(setInterval(() => { void checkSelfMembership(); }, STATUS_REFRESH_MS));
    void checkSelfMembership();
    const messages = (joined) => {
        const self = findMember(joined.roster, machineId);
        if (!self)
            throw new Error('This machine is no longer a network member');
        const started = performance.now();
        try {
            return new ConversationMessages({ file: path.join(dataDir, 'messages.db'), busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS,
                network: { network_id: joined.config.network_id, self: { id: machineId, name: self.name },
                    members: joined.roster.members.map(m => ({ id: m.machine_id, name: m.name })) } });
        }
        finally {
            lastMessageStoreOpen = { started, finished: performance.now() };
        }
    };
    let lastPresenceAt = 0;
    const answer = async (frame, joined, remoteId) => {
        const member = findMember(joined.roster, remoteId);
        if (!member)
            return { result: 'rejected', code: 'not_a_member' };
        const store = messages(joined);
        try {
            if (frame.kind === 'peer-routes') {
                receivePeerRoutes(db, joined, remoteId, frame.routes);
                return { result: 'accepted' };
            }
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
    const deliverTo = async (target, outgoing, receipts) => {
        sendingTo.add(target);
        try {
            for (const row of outgoing) {
                if (stopping)
                    return;
                const { ack, path } = await sendFrame(target, { version: 2, kind: 'conversation-message', row });
                appendLog(dataDir, 'frame_sent', { frame: 'conversation-message', message_id: row.message.id, result: ack.result, path });
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
                const { ack, path } = await sendFrame(target, { version: 2, kind: 'conversation-receipt', receipt });
                appendLog(dataDir, 'frame_sent', { frame: 'conversation-receipt', message_id: receipt.message_id, result: ack.result, path });
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
    const announce = (joined, heartbeat, presence) => {
        const routes = isOwner && relayUrl === RELAY_OFF ? memberRoutes(db, joined, machineId) : [];
        for (const member of joined.roster.members) {
            const target = member.machine_id;
            if (target === machineId || announcingTo.has(target))
                continue;
            const frames = routes.length ? [...presence, ...peerRouteFrames(routes.filter(route => route.machine_id !== target))] : presence;
            const content = JSON.stringify(frames);
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
                    if (ack.result !== 'accepted') {
                        if (frame.kind === 'peer-routes' && ack.result === 'rejected' && ack.code === 'frame_invalid')
                            continue;
                        throw new Error('Presence not accepted');
                    }
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
            if (!findMember(joined.roster, machineId)) {
                clearMembership(db, joined.config, joined.roster.version);
                revokeConnections();
                finishDeparture();
                return;
            }
            const now = Date.now();
            const store = messages(joined);
            let presence;
            try {
                store.maintainMessages();
                for (const member of joined.roster.members) {
                    const target = member.machine_id;
                    if (target === machineId || sendingTo.has(target))
                        continue;
                    try {
                        void deliverTo(target, store.outgoingFor(target), store.receiptsFor(target));
                    }
                    catch (err) {
                        recordError('courier_failed', errorMessage(err));
                    }
                }
                presence = conversationPresenceFrames(relayUrl === RELAY_OFF ? null : relayUrl, advertisedAddresses(endpoint), store.exportRegistrations());
            }
            finally {
                store.close();
            }
            const heartbeat = now - lastPresenceAt >= PRESENCE_INTERVAL_MS;
            if (heartbeat)
                lastPresenceAt = now;
            announce(joined, heartbeat, presence);
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
            else if (alpn === MEMBERSHIP_ALPN)
                await answerMembership(connection, remoteId);
            else {
                connection.close(2n, toBytes('unknown_protocol'));
                appendLog(dataDir, 'unknown_protocol_refused', { machine_id: remoteId });
            }
        }
        catch (err) {
            recordError('connection_failed', errorMessage(err));
            const notMember = errorMessage(err) === 'not_a_member';
            if (notMember) {
                status.non_member_refused++;
                publish();
            }
            try {
                connection?.close(3n, toBytes(notMember ? 'not_a_member' : 'error'));
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