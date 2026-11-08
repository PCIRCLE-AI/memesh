// The router starts the bridge when a host connects and this machine has joined.
// For a machine that never joined, this is one stat of the network folder and
// nothing else. It never blocks or fails the router: the start runs in the
// background, and a failure is written to the router's own stderr.

import fs from 'node:fs';
import path from 'node:path';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { startBridge } from './bridge-control.js';
import { readConfig } from './store.js';
import { networkDir, type NetworkContext } from './types.js';

const RETRY_AFTER_MS = 30_000;

export interface AutoStartOptions {
  dataDir: string;
  dbPath: string;
  db: MemeshDatabase;
  /** Folder holding the built bridge.js and the runtime pin files. */
  networkDistDir: string;
  start?: typeof startBridge;
  report?: (message: string) => void;
  now?: () => number;
}

export type AutoStartResult = 'not-joined' | 'recently-tried' | 'starting';

let lastTriedAt = Number.NEGATIVE_INFINITY;

export function maybeStartNetworkBridge(options: AutoStartOptions): AutoStartResult {
  if (!fs.existsSync(networkDir(options.dataDir))) return 'not-joined';
  let joined: boolean;
  try {
    joined = readConfig(options.db) !== null;
  } catch {
    joined = false; // No network tables: never joined.
  }
  if (!joined) return 'not-joined';
  const now = (options.now ?? Date.now)();
  if (now - lastTriedAt < RETRY_AFTER_MS) return 'recently-tried';
  lastTriedAt = now;
  const ctx: NetworkContext = {
    dataDir: options.dataDir,
    dbPath: options.dbPath,
    bridgeEntry: path.join(options.networkDistDir, 'bridge.js'),
    assetsDir: options.networkDistDir,
  };
  const report = options.report ?? ((message: string) => { try { process.stderr.write(`${message}\n`); } catch { /* stderr gone */ } });
  void (options.start ?? startBridge)(ctx).catch((err: unknown) => {
    report(`MeMesh router could not start the network bridge: ${err instanceof Error ? err.message : String(err)}`);
  });
  return 'starting';
}

/** For tests: forget the last attempt. */
export function resetAutoStartForTests(): void {
  lastTriedAt = Number.NEGATIVE_INFINITY;
}
