// The router starts the bridge when a host connects and this machine has joined.
// For a machine that never joined, this is one stat of the network folder and
// nothing else. It never blocks or fails the router: the start runs in the
// background, and a failure is written to the router's own stderr.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { probeBridge } from './control-socket.js';
import { logPath } from './bridge-state.js';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { startBridge } from './bridge-control.js';
import { readConfig } from './store.js';
import { networkDir, childEnv, type NetworkContext } from './types.js';

/** Short-lived public bootstrap; the hook does not wait for migration or installation. */
export async function bootstrapNetworkBridge(ctx: NetworkContext, cliEntry: string): Promise<'not-joined' | 'running' | 'starting'> {
  let directory: fs.Stats;
  try { directory = fs.lstatSync(networkDir(ctx.dataDir)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not-joined'; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || (process.platform !== 'win32' && (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0))) throw new Error('Unsafe network directory');
  const probe = await probeBridge(ctx.dataDir, 200);
  if (probe.kind === 'running') return 'running';
  if (probe.kind === 'unresponsive') throw new Error('Network bridge unresponsive; bootstrap refused');
  const fd = fs.openSync(logPath(ctx.dataDir), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw new Error('Unsafe network log');
    const child = spawn(process.execPath, [cliEntry, 'network', 'up'], { env: childEnv(ctx), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return 'starting';
  } finally { fs.closeSync(fd); }
}

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
