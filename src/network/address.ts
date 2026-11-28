// Cross-machine addresses and project hashes. Pure: no database, no network.

import { createHash } from 'node:crypto';
import { NAME } from './roster.js';

export interface NetworkAddress {
  person: string;
  /** The principal or session handle on the other machine. */
  target: string;
  machine: string;
}

// The part between `/` and `@` is a local name over there; it may not hold either.
const TARGET = /^[^/@\s]{1,200}$/;

/** `person/target@machine`, split on the last `@`, then the first `/`. Null when it is not that shape. */
export function parseNetworkAddress(value: string): NetworkAddress | null {
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const machine = value.slice(at + 1);
  const left = value.slice(0, at);
  const slash = left.indexOf('/');
  if (slash <= 0) return null;
  const person = left.slice(0, slash);
  const target = left.slice(slash + 1);
  if (!NAME.test(person) || !NAME.test(machine) || !TARGET.test(target)) return null;
  return { person, target, machine };
}

export function formatNetworkAddress(person: string, target: string, machine: string): string {
  return `${person}/${target}@${machine}`;
}

/**
 * What crosses the network in place of a project id: a member learns a project
 * only if it already has a project with the same id itself.
 */
export function projectHash(networkId: string, project: string): string {
  return createHash('sha256').update(`${networkId}:${project}`).digest('hex');
}

/** A sender name that can be carried as-is: a local principal, not an address. */
export function isLocalSenderName(value: string): boolean {
  return TARGET.test(value);
}
