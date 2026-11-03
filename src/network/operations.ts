// What the `memesh network` subcommands do, as functions with no terminal in them,
// so link and join are testable though their commands refuse to run without one.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { describeChildDeath, startBridge } from './bridge-control.js';
import type { JoinChildInput, JoinChildResult } from './bridge-join.js';
import { readStatus, reportedPid, type BridgeStatus } from './bridge-state.js';
import { assertControlPathFits, probeBridge } from './control-socket.js';
import { ensureIdentity, loadIdentity } from './identity.js';
import { DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS, createInvite, encodeLink, parseLink, type InviteLink } from './invites.js';
import { parseJoinReply, refusalMessage } from './join-protocol.js';
import { parseRelayUrl } from './relay-url.js';
import { acceptRoster, assertValidName, createRoster, findMember, parseRoster, signRoster } from './roster.js';
import { ensureRuntime, type InstallOptions } from './runtime.js';
import { databaseExists, insertConfig, openNetworkStore, readConfig, type NetworkConfig } from './store.js';
import {
  DEFAULT_RELAY_URL, NetworkError, RELAY_OFF, SINGLE_MACHINE_NOTE, childEnv, errorMessage, networkDir, safeForTerminal,
  type NetworkContext, type Roster, type RosterMember,
} from './types.js';

const JOIN_CHILD_DEADLINE_MS = 90_000;
const JOIN_CHILD_OUTPUT_MAX_BYTES = 1024 * 1024;
const ADDRESS_WAIT_MS = 10_000;

const HOUR_MS = 3_600_000;

function resolveRelay(relay: string | undefined, fallback: string): string {
  const value = relay ?? fallback;
  if (value === RELAY_OFF) return RELAY_OFF;
  const url = parseRelayUrl(value);
  if (url === null) {
    throw new NetworkError('invalid_option', '--relay must be "off", or an https URL with no user name or password (plain http only on this machine\'s loopback address).');
  }
  return url;
}

const NOT_JOINED = 'This machine is not in a network yet. Run `memesh network create` or `memesh network join`.';

function withConfig<T>(ctx: NetworkContext, use: (db: ReturnType<typeof openNetworkStore>, config: NetworkConfig) => T): T {
  // Asking must not create: someone who never joined keeps having no database.
  if (!databaseExists(ctx.dbPath)) throw new NetworkError('not_joined', NOT_JOINED);
  const db = openNetworkStore(ctx.dbPath);
  try {
    const config = readConfig(db);
    if (!config) {
      throw new NetworkError('not_joined', NOT_JOINED);
    }
    return use(db, config);
  } finally {
    db.close();
  }
}

function refuseIfAlreadyJoined(ctx: NetworkContext): void {
  if (!databaseExists(ctx.dbPath)) return;
  const db = openNetworkStore(ctx.dbPath);
  try {
    const config = readConfig(db);
    if (config) {
      throw new NetworkError('already_joined', `This machine is already in a network as "${config.machine_name}". Leaving a network is not available yet.`);
    }
  } finally {
    db.close();
  }
}

export interface CreateOptions extends InstallOptions {
  name: string;
  person: string;
  relay?: string;
}

export function createNetwork(ctx: NetworkContext, options: CreateOptions): { config: NetworkConfig; roster: Roster } {
  assertValidName('machine name', options.name);
  assertValidName('person', options.person);
  const relay = resolveRelay(options.relay, DEFAULT_RELAY_URL);
  assertControlPathFits(ctx.dataDir);
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
  const config: NetworkConfig = {
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
  } finally {
    db.close();
  }
  return { config, roster };
}

export interface LinkOptions {
  ttlHours?: number;
  includeAddresses?: boolean;
}

export interface LinkResult {
  link: string;
  expiresAtMs: number;
  /** Direct addresses were asked for and none were found, so the link has none. */
  addressesMissing: boolean;
  bridgeStarted: boolean;
  bridgePid: number;
}

async function waitForDirectAddresses(ctx: NetworkContext): Promise<string[]> {
  const giveUpAt = Date.now() + ADDRESS_WAIT_MS;
  for (;;) {
    const status = readStatus(ctx.dataDir);
    if (status && status.direct_addresses.length > 0) return status.direct_addresses;
    if (Date.now() >= giveUpAt) return [];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Owner only. Starts the bridge first, so a link is never handed out for a machine that cannot answer it. */
export async function createLink(ctx: NetworkContext, options: LinkOptions = {}): Promise<LinkResult> {
  const hours = options.ttlHours ?? DEFAULT_INVITE_TTL_HOURS;
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_INVITE_TTL_HOURS) {
    throw new NetworkError('invalid_option', `--ttl-hours must be a number above 0 and at most ${MAX_INVITE_TTL_HOURS}.`);
  }
  // Whole milliseconds: a link's expiry must be an integer or `join` refuses the link.
  const ttlMs = Math.ceil(hours * HOUR_MS);

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
  let addrs: string[] = [];
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
    const fields: InviteLink = {
      v: 1,
      network_id: config.network_id,
      owner_id: config.owner_id,
      relay: config.relay_url === RELAY_OFF ? null : config.relay_url,
      token,
      expires_at_ms: expiresAtMs,
      ...(addrs.length > 0 ? { addrs } : {}),
    };
    return {
      link: encodeLink(identity, fields),
      expiresAtMs,
      addressesMissing: options.includeAddresses === true && addrs.length === 0,
      bridgeStarted: bridge.started,
      bridgePid: bridge.pid,
    };
  } finally {
    db.close();
  }
}

/** Run the client half in a child and read its one JSON result. Its death is an error here, not a crash. */
export function runJoinChild(ctx: NetworkContext, input: JoinChildInput, deadlineMs: number = JOIN_CHILD_DEADLINE_MS): Promise<JoinChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ctx.bridgeEntry, 'join'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(ctx), windowsHide: true,
    });
    let output = '';
    let lastError = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (output.length < JOIN_CHILD_OUTPUT_MAX_BYTES) output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { lastError = chunk.slice(-500); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new NetworkError('bridge_failed', `The network component could not start: ${err.message}. ${SINGLE_MACHINE_NOTE}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new NetworkError('join_timed_out', `Joining did not finish within ${Math.round(deadlineMs / 1000)} s and was stopped. Running join again with the same link is safe.`));
        return;
      }
      try {
        resolve(JSON.parse(output) as JoinChildResult);
      } catch {
        const stderrLine = lastError.trim().split('\n')[0];
        const why = stderrLine ? ` Its last message: ${stderrLine}.` : '';
        reject(new NetworkError('bridge_failed', `The network component ${describeChildDeath(code, signal)}.${why} Running join again with the same link is safe, and reinstalls its files if they are damaged. ${SINGLE_MACHINE_NOTE}`));
      }
    });
    // A child that died before reading its input surfaces through `close`.
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

export interface JoinOptions extends InstallOptions {
  link: string;
  name: string;
  person: string;
  relay?: string;
}

export interface JoinResult {
  config: NetworkConfig;
  roster: Roster;
  member: RosterMember;
  /** Did this machine reach its own relay? Null when it runs with the relay off. */
  relayReached: boolean | null;
}

export async function joinNetwork(ctx: NetworkContext, options: JoinOptions): Promise<JoinResult> {
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
  if (relay === RELAY_OFF && !link.addrs?.length) {
    throw new NetworkError('invalid_option', 'This link can only be reached through a relay, so it cannot be used with --relay off. Ask for a link made with --include-addresses.');
  }
  assertControlPathFits(ctx.dataDir);
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
    if (result.code === 'relay_unreachable') {
      throw new NetworkError('relay_unreachable', `This machine could not reach its relay (${safeForTerminal(result.detail)}). The invite was not used and nothing was saved. Check this machine's connection and the relay address, then try again.`);
    }
    if (result.code === 'owner_unreachable') {
      const advice = result.relay_reached === false
        ? 'This machine could not reach its relay either, so check this machine\'s connection first.'
        : 'Its bridge must be running: on that machine, run `memesh network up`.';
      throw new NetworkError('owner_unreachable', `Could not reach the network owner's machine (${safeForTerminal(result.detail)}). ${advice} The invite was not used.`);
    }
    if (result.code === 'join_interrupted') {
      throw new NetworkError('join_interrupted', `Reached the network owner's machine, but the join did not finish (${safeForTerminal(result.detail)}). Running join again with the same link is safe.`);
    }
    throw new NetworkError(result.code, `Could not join: ${safeForTerminal(result.detail)}. ${SINGLE_MACHINE_NOTE}`);
  }

  const reply = parseJoinReply(Buffer.from(result.reply));
  if (!reply.ok) throw new NetworkError(reply.error, refusalMessage(reply.error));

  // The owner to check against comes from the link, never from the reply.
  const roster = acceptRoster(null, reply.roster, link.owner_id, link.network_id);
  const member = findMember(roster, identity.machineId);
  if (!member) {
    throw new NetworkError('roster_invalid', "The owner's reply does not list this machine.");
  }
  const config: NetworkConfig = {
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
  } finally {
    db.close();
  }
  return { config, roster, member, relayReached: result.relay_reached };
}

/** Starting the bridge needs a network to serve. */
export async function bridgeUp(ctx: NetworkContext, options: InstallOptions = {}): Promise<{ pid: number; started: boolean }> {
  withConfig(ctx, () => undefined);
  if (options.force) {
    // Its files are loaded in that process, and replacing them under it helps nobody.
    if ((await probeBridge(ctx.dataDir)).kind !== 'not-running') {
      throw new NetworkError('bridge_unresponsive', 'The network bridge is running, so its files cannot be reinstalled. Stop it first with `memesh network down`.');
    }
    ensureRuntime(ctx, options);
  }
  return startBridge(ctx);
}

export type NetworkStatus = { joined: false } | JoinedStatus;

export interface JoinedStatus {
  joined: true;
  network_id: string;
  machine_id: string;
  machine_name: string;
  person: string;
  role: 'owner' | 'member';
  relay: string;
  roster_version: number;
  members: RosterMember[];
  bridge: {
    running: boolean;
    /** Something holds the control socket and did not answer. */
    unresponsive: boolean;
    pid: number | null;
    started_at: string | null;
    relay_state: BridgeStatus['relay_state'] | null;
    last_error: string | null;
    last_error_at: string | null;
    joins_accepted: number;
    joins_refused: number;
    non_member_refused: number;
  };
}

/**
 * Read-only for someone who never opted in: with no network folder this returns
 * before opening anything, so `status` cannot itself create network state.
 */
export async function getNetworkStatus(ctx: NetworkContext): Promise<NetworkStatus> {
  if (!fs.existsSync(networkDir(ctx.dataDir)) || !fs.existsSync(ctx.dbPath)) return { joined: false };
  const db = openNetworkStore(ctx.dbPath);
  let config: NetworkConfig | null;
  try {
    config = readConfig(db);
  } catch (err) {
    throw new NetworkError('internal', `Cannot read the network settings: ${errorMessage(err)}`);
  } finally {
    db.close();
  }
  if (!config) return { joined: false };

  const roster = parseRoster(config.roster_json);
  const probe = await probeBridge(ctx.dataDir);
  const running = probe.kind === 'running';
  const status = readStatus(ctx.dataDir);
  // The status file can be an earlier bridge's: its live fields count only if this one answered with its pid.
  const current = running && status?.pid === probe.pid ? status : null;
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
      unresponsive: probe.kind === 'unresponsive',
      // When it does not answer, its own earlier status is all there is to go on.
      pid: running ? probe.pid : probe.kind === 'unresponsive' ? reportedPid(status) : null,
      started_at: current?.started_at ?? null,
      relay_state: current?.relay_state ?? null,
      last_error: status?.last_error ?? null,
      last_error_at: status?.last_error_at ?? null,
      joins_accepted: current?.joins_accepted ?? 0,
      joins_refused: current?.joins_refused ?? 0,
      non_member_refused: current?.non_member_refused ?? 0,
    },
  };
}
