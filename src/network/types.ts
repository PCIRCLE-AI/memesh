// Shared vocabulary of the cross-machine network. No side effects at import:
// nothing in src/network runs for someone who never ran create or join.

import path from 'node:path';

export const JOIN_ALPN = 'memesh/join/1';
export const NET_ALPN = 'memesh/net/1';
export const DEFAULT_RELAY_URL = 'https://relay.memesh.ai/';
export const RELAY_OFF = 'off';

/** The bridge's exit status when another bridge already holds the data dir. */
export const EXIT_ALREADY_RUNNING = 3;

export const SINGLE_MACHINE_NOTE = 'Single-machine MeMesh keeps working; nothing else was changed.';

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
  | 'runtime_unsupported'
  | 'runtime_install_failed'
  | 'runtime_load_failed'
  | 'bridge_failed';

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
  invite_epoch: number;
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

/** A child resolves the same data dir and database as the parent, whatever the parent inherited. */
export function childEnv(ctx: NetworkContext): NodeJS.ProcessEnv {
  return { ...(ctx.env ?? process.env), MEMESH_DIR: ctx.dataDir, MEMESH_DB_PATH: ctx.dbPath };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
