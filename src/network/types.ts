// Shared vocabulary of the cross-machine network. No side effects at import:
// nothing in src/network runs for someone who never ran create or join.

import path from 'node:path';

export const JOIN_ALPN = 'memesh/join/1';
export const NET_ALPN = 'memesh/net/1';
export const DEFAULT_RELAY_URL = 'https://relay.memesh.ai/';
export const RELAY_OFF = 'off';

/** The bridge's exit status when another bridge already holds the data dir. */
export const EXIT_ALREADY_RUNNING = 3;
/** The bridge's exit status when a live process holds the lock and it cannot tell whose. */
export const EXIT_LOCK_UNCONFIRMED = 4;

export const SINGLE_MACHINE_NOTE = 'Single-machine MeMesh keeps working.';

export type NetworkErrorCode =
  | 'invite_used'
  | 'invite_expired'
  | 'invite_unknown'
  | 'name_taken'
  | 'wrong_network'
  | 'invalid_name'
  | 'bad_request'
  | 'not_owner'
  | 'roster_full'
  | 'internal'
  | 'unknown_refusal'
  | 'link_malformed'
  | 'link_tampered'
  | 'link_version'
  | 'roster_invalid'
  | 'roster_downgrade'
  | 'identity_invalid'
  | 'not_joined'
  | 'already_joined'
  | 'needs_person'
  | 'invalid_option'
  | 'owner_unreachable'
  | 'relay_unreachable'
  | 'join_interrupted'
  | 'join_timed_out'
  | 'runtime_unsupported'
  | 'runtime_install_failed'
  | 'runtime_load_failed'
  | 'bridge_failed'
  | 'bridge_unconfirmed';

/** An expected failure with a sentence for a person. Messages never carry a token. */
export class NetworkError extends Error {
  readonly code: NetworkErrorCode;
  constructor(code: NetworkErrorCode, message: string) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
  }
}

export interface RosterMember {
  machine_id: string;
  name: string;
  person: string;
  joined_at: string;
}

export interface Roster {
  network_id: string;
  owner_id: string;
  version: number;
  members: RosterMember[];
}

/** The exact signed bytes travel with the signature: a roster is never re-serialised to verify. */
export interface SignedRoster {
  roster_json: string;
  signature: string;
}

/** Where one MeMesh data dir lives, and where this build's network files are. */
export interface NetworkContext {
  dataDir: string;
  dbPath: string;
  /** Absolute path of the built bridge entry (dist/network/bridge.js). */
  bridgeEntry: string;
  /** Folder holding the shipped runtime-lock.json and runtime-package.json. */
  assetsDir: string;
  /** Environment for child processes. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export function networkDir(dataDir: string): string {
  return path.join(dataDir, 'network');
}

export function runtimeDir(dataDir: string): string {
  return path.join(networkDir(dataDir), 'runtime');
}

/**
 * A child resolves the same data dir and database as the parent, whatever the
 * parent inherited. NODE_PATH and NAPI_RS_* are dropped: either one can point the
 * loader at a native file the pinned checksums never covered.
 */
export function childEnv(ctx: NetworkContext): NodeJS.ProcessEnv {
  const inherited = Object.entries(ctx.env ?? process.env).filter(([key]) => {
    const name = key.toUpperCase();
    return name !== 'NODE_PATH' && !name.startsWith('NAPI_RS_');
  });
  return { ...Object.fromEntries(inherited), MEMESH_DIR: ctx.dataDir, MEMESH_DB_PATH: ctx.dbPath };
}

/** Nothing a link, a reply or a peer supplied may move the cursor or write to the terminal. */
export function safeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
