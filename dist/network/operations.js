import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { startBridge, describeBridgeDeath } from './bridge-control.js';
import { readStatus, runningBridgePid } from './bridge-state.js';
import { ensureIdentity, loadIdentity } from './identity.js';
import { DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS, createInvite, encodeLink, parseLink } from './invites.js';
import { parseJoinReply, refusalMessage } from './join-protocol.js';
import { acceptRoster, assertValidName, createRoster, findMember, parseRoster, signRoster } from './roster.js';
import { ensureRuntime } from './runtime.js';
import { insertConfig, openNetworkStore, readConfig } from './store.js';
import { DEFAULT_RELAY_URL, NetworkError, RELAY_OFF, SINGLE_MACHINE_NOTE, childEnv, errorMessage, networkDir, } from './types.js';
const JOIN_CHILD_DEADLINE_MS = 90_000;
const JOIN_CHILD_OUTPUT_MAX_BYTES = 1024 * 1024;
const ADDRESS_WAIT_MS = 10_000;
const HOUR_MS = 3_600_000;
function resolveRelay(relay, fallback) {
    const value = relay ?? fallback;
    if (value === RELAY_OFF)
        return RELAY_OFF;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new NetworkError('invalid_option', `--relay must be an http(s) URL or "off".`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new NetworkError('invalid_option', `--relay must be an http(s) URL or "off".`);
    }
    return url.toString();
}
function withConfig(ctx, use) {
    const db = openNetworkStore(ctx.dbPath);
    try {
        const config = readConfig(db);
        if (!config) {
            throw new NetworkError('not_joined', 'This machine is not in a network yet. Run `memesh network create` or `memesh network join`.');
        }
        return use(db, config);
    }
    finally {
        db.close();
    }
}
function refuseIfAlreadyJoined(ctx) {
    const db = openNetworkStore(ctx.dbPath);
    try {
        const config = readConfig(db);
        if (config) {
            throw new NetworkError('already_joined', `This machine is already in a network as "${config.machine_name}". Leaving a network is not available yet.`);
        }
    }
    finally {
        db.close();
    }
}
export function createNetwork(ctx, options) {
    assertValidName('machine name', options.name);
    assertValidName('person', options.person);
    const relay = resolveRelay(options.relay, DEFAULT_RELAY_URL);
    refuseIfAlreadyJoined(ctx);
    ensureRuntime(ctx, options);
    const identity = ensureIdentity(ctx.dataDir);
    const now = Date.now();
    const networkId = randomBytes(16).toString('hex');
    const roster = createRoster(networkId, {
        machine_id: identity.machineId,
        name: options.name,
        person: options.person,
        joined_at: new Date(now).toISOString(),
    });
    const signed = signRoster(identity, roster);
    const config = {
        network_id: networkId,
        owner_id: identity.machineId,
        machine_id: identity.machineId,
        machine_name: options.name,
        person: options.person,
        relay_url: relay,
        roster_json: signed.roster_json,
        roster_signature: signed.signature,
    };
    const db = openNetworkStore(ctx.dbPath);
    try {
        insertConfig(db, config, now);
    }
    finally {
        db.close();
    }
    return { config, roster };
}
async function waitForDirectAddresses(ctx) {
    const giveUpAt = Date.now() + ADDRESS_WAIT_MS;
    for (;;) {
        const status = readStatus(ctx.dataDir);
        if (status && status.direct_addresses.length > 0)
            return status.direct_addresses;
        if (Date.now() >= giveUpAt)
            return [];
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
export async function createLink(ctx, options = {}) {
    const hours = options.ttlHours ?? DEFAULT_INVITE_TTL_HOURS;
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_INVITE_TTL_HOURS) {
        throw new NetworkError('invalid_option', `--ttl-hours must be a number above 0 and at most ${MAX_INVITE_TTL_HOURS}.`);
    }
    const ttlMs = options.ttlMs ?? hours * HOUR_MS;
    const config = withConfig(ctx, (_db, stored) => {
        if (stored.owner_id !== stored.machine_id) {
            throw new NetworkError('not_owner', 'Only the machine that created the network can make invite links.');
        }
        return stored;
    });
    if (config.relay_url === RELAY_OFF && !options.includeAddresses) {
        throw new NetworkError('invalid_option', 'This network runs with the relay off, so a link needs --include-addresses or the other machine has no way to reach this one.');
    }
    const bridge = await startBridge(ctx);
    let addrs;
    if (options.includeAddresses) {
        addrs = await waitForDirectAddresses(ctx);
        if (addrs.length === 0 && config.relay_url === RELAY_OFF) {
            throw new NetworkError('bridge_failed', 'The bridge has no direct addresses yet, and with the relay off the link would be useless. Check your network connection and try again.');
        }
    }
    const identity = loadIdentity(ctx.dataDir);
    const db = openNetworkStore(ctx.dbPath);
    try {
        const { token, expiresAtMs } = createInvite(db, ttlMs, Date.now());
        const fields = {
            v: 1,
            network_id: config.network_id,
            owner_id: config.owner_id,
            relay: config.relay_url === RELAY_OFF ? null : config.relay_url,
            token,
            expires_at_ms: expiresAtMs,
            ...(addrs ? { addrs } : {}),
        };
        return { link: encodeLink(identity, fields), expiresAtMs, bridgeStarted: bridge.started, bridgePid: bridge.pid };
    }
    finally {
        db.close();
    }
}
function runJoinChild(ctx, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ctx.bridgeEntry, 'join'], {
            stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(ctx), windowsHide: true,
        });
        let output = '';
        let lastError = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), JOIN_CHILD_DEADLINE_MS);
        child.stdout.setEncoding('utf8').on('data', (chunk) => {
            if (output.length < JOIN_CHILD_OUTPUT_MAX_BYTES)
                output += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { lastError = chunk.slice(-500); });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new NetworkError('bridge_failed', `The network component could not start: ${err.message}. ${SINGLE_MACHINE_NOTE}`));
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            try {
                resolve(JSON.parse(output));
            }
            catch {
                reject(new NetworkError('bridge_failed', describeBridgeDeath(code, signal, lastError.trim().split('\n')[0] || null)));
            }
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(JSON.stringify(input));
    });
}
export async function joinNetwork(ctx, options) {
    const link = parseLink(options.link);
    assertValidName('machine name', options.name);
    assertValidName('person', options.person);
    if (link.expires_at_ms <= Date.now()) {
        throw new NetworkError('invite_expired', refusalMessage('invite_expired'));
    }
    const relay = resolveRelay(options.relay, link.relay ?? RELAY_OFF);
    if (link.relay === null && !link.addrs?.length) {
        throw new NetworkError('link_malformed', 'This invite link has neither a relay nor direct addresses, so it leads nowhere. Ask for a new one.');
    }
    refuseIfAlreadyJoined(ctx);
    ensureRuntime(ctx, options);
    const identity = ensureIdentity(ctx.dataDir);
    if (identity.machineId === link.owner_id) {
        throw new NetworkError('wrong_network', 'This link was made on this machine. Run join on the other machine.');
    }
    const result = await runJoinChild(ctx, {
        request: { network_id: link.network_id, token: link.token, name: options.name, person: options.person },
        owner_id: link.owner_id,
        owner_relay: link.relay,
        owner_addrs: link.addrs,
        own_relay: relay,
    });
    if (!result.ok) {
        if (result.code === 'owner_unreachable') {
            throw new NetworkError('owner_unreachable', `Could not reach the network owner's machine (${result.detail}). Its bridge must be running: on that machine, run \`memesh network up\`.`);
        }
        throw new NetworkError(result.code, `Could not join: ${result.detail}. ${SINGLE_MACHINE_NOTE}`);
    }
    const reply = parseJoinReply(Buffer.from(result.reply));
    if (!reply.ok)
        throw new NetworkError(reply.error, refusalMessage(reply.error));
    const roster = acceptRoster(null, reply.roster, link.owner_id, link.network_id);
    const member = findMember(roster, identity.machineId);
    if (!member) {
        throw new NetworkError('roster_invalid', "The owner's reply does not list this machine.");
    }
    const config = {
        network_id: link.network_id,
        owner_id: link.owner_id,
        machine_id: identity.machineId,
        machine_name: member.name,
        person: member.person,
        relay_url: relay,
        roster_json: reply.roster.roster_json,
        roster_signature: reply.roster.signature,
    };
    const db = openNetworkStore(ctx.dbPath);
    try {
        insertConfig(db, config, Date.now());
    }
    finally {
        db.close();
    }
    return { config, roster, member };
}
export async function bridgeUp(ctx, options = {}) {
    withConfig(ctx, () => undefined);
    if (options.force)
        ensureRuntime(ctx, options);
    return startBridge(ctx);
}
export function getNetworkStatus(ctx) {
    if (!fs.existsSync(networkDir(ctx.dataDir)) || !fs.existsSync(ctx.dbPath))
        return { joined: false };
    const db = openNetworkStore(ctx.dbPath);
    let config;
    try {
        config = readConfig(db);
    }
    catch (err) {
        throw new NetworkError('internal', `Cannot read the network settings: ${errorMessage(err)}`);
    }
    finally {
        db.close();
    }
    if (!config)
        return { joined: false };
    const roster = parseRoster(config.roster_json);
    const pid = runningBridgePid(ctx.dataDir);
    const status = readStatus(ctx.dataDir);
    const running = pid !== null;
    return {
        joined: true,
        network_id: config.network_id,
        machine_id: config.machine_id,
        machine_name: config.machine_name,
        person: config.person,
        role: config.owner_id === config.machine_id ? 'owner' : 'member',
        relay: config.relay_url,
        roster_version: roster.version,
        members: roster.members,
        bridge: {
            running,
            pid,
            started_at: running ? status?.started_at ?? null : null,
            relay_state: running ? status?.relay_state ?? null : null,
            last_error: status?.last_error ?? null,
            last_error_at: status?.last_error_at ?? null,
            joins_accepted: running ? status?.joins_accepted ?? 0 : 0,
            joins_refused: running ? status?.joins_refused ?? 0 : 0,
            non_member_refused: running ? status?.non_member_refused ?? 0 : 0,
        },
    };
}
//# sourceMappingURL=operations.js.map