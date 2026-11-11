#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, getDatabase, isDatabaseOpen, openDatabase } from '../db.js';
import { assertNodeSupported } from '../storage/sqlite.js';
import { startAgentMessageExpiryScheduler } from '../core/agent-message-expiry.js';
import { AgentRouter, AgentRouterError, AGENT_ROUTER_SOCKET_PATH_MAX_BYTES, type AgentHostRegistration } from '../core/agent-router.js';
import { createCodexCliQueueAdapter } from '../host-adapters/codex-cli-queue.js';
import { getAgentRouterSocketPath, getMemeshDirFromDbPath } from '../core/paths.js';
import { assertSecureLocalHostRuntimeSupported, ensureRouterTokenFile } from './config.js';
import { memeshPackageVersion } from './package-version.js';
import { requirePrivateWritableDirectory } from '../core/file-mode.js';
import { fileURLToPath } from 'node:url';
import { maybeStartNetworkBridge } from '../network/auto-start.js';
import { getDbPath } from '../core/paths.js';
import { recordRouterIdleExit, routerIdleSettings, watchRouterIdle } from './router-idle.js';

const dataDir = getMemeshDirFromDbPath();
const socketFromEnv = process.env.MEMESH_ROUTER_SOCKET;
const socketPath = socketFromEnv ?? getAgentRouterSocketPath();
const tokenFile = process.env.MEMESH_ROUTER_TOKEN_FILE ?? path.join(dataDir, 'agent-router.token');

// The one reported-failure path for everything before AND during startup —
// the mkdir/chmod, the token file, and the constructor below all throw
// synchronously and none of them reach `router.start().catch()`. Shared with
// that later catch too, so the two "MeMesh router failed" lines cannot drift
// apart in format.
function reportFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  const isSocketPathError = error instanceof AgentRouterError && error.code === 'invalid_socket_path';
  const detail = [
    code ? `code=${code}` : null,
    isSocketPathError
      ? `socket_path=${socketPath} (${Buffer.byteLength(socketPath)} bytes, limit ${AGENT_ROUTER_SOCKET_PATH_MAX_BYTES}${socketFromEnv ? ', from MEMESH_ROUTER_SOCKET' : ''})`
      : null,
  ].filter(Boolean).join(', ');
  try { process.stderr.write(`MeMesh router failed: ${message}${detail ? ` (${detail})` : ''}\n`); } catch { /* stderr gone */ }
  try { closeDatabase(); } catch { /* the database may never have opened */ }
  process.exit(1);
}

let router: AgentRouter;
let database: ReturnType<typeof openDatabase>;
try {
  // First, before the token or the data folder are touched: on a Node below
  // the floor the router cannot run, and must leave nothing behind.
  assertNodeSupported();
  assertSecureLocalHostRuntimeSupported();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  requirePrivateWritableDirectory(dataDir, 'the router keeps its socket, token and messages there');
  const expectedToken = ensureRouterTokenFile(tokenFile);

  const authenticate = (registration: AgentHostRegistration): boolean => {
    if (!registration.auth_token) return false;
    const actual = Buffer.from(registration.auth_token);
    const expected = Buffer.from(expectedToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const db = database = openDatabase();
  router = new AgentRouter({
    db,
    socket_path: socketPath,
    memesh_version: memeshPackageVersion(),
    // A host of a newer MeMesh registered: this process runs old code, so it
    // steps aside and the next host connection starts the installed one (#518).
    on_superseded: () => { void shutdown().finally(() => process.exit(0)); },
    // A machine that has joined a network gets its bridge started; one that never joined costs one stat.
    on_host_connected: () => {
      maybeStartNetworkBridge({ dataDir, dbPath: getDbPath(), db, networkDistDir: fileURLToPath(new URL('../network/', import.meta.url)) });
    },
    adapters: [
      createCodexCliQueueAdapter({ authenticate, release_watch: { db } }),
      ...['claude-channel', 'claude-inbox', 'codex-app-server', 'acp'].map(kind => ({ kind, authenticate })),
    ],
  });
} catch (error) {
  reportFailure(error);
}

// Messages are kept one day (agent-message-expiry.ts). The router is the
// long-lived process that has the database open, so it runs the pass: shortly
// after start (the socket is already listening by then) and every few minutes.
let stopExpiry: () => void = () => undefined;

async function shutdown(): Promise<void> {
  stopExpiry();
  await router.stop();
  closeDatabase();
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

router.start().then(() => {
  stopExpiry = startAgentMessageExpiryScheduler(() => (isDatabaseOpen() ? getDatabase() : null), { trigger: 'router' });
  // Nothing else ever stops this process, so it leaves when no host has been connected, and
  // nothing has been delivered, for a while. The next host connection starts a new one.
  const { idleMs, checkMs } = routerIdleSettings(process.env);
  watchRouterIdle({
    db: database,
    idleMs,
    checkMs,
    onIdle: () => {
      // The hosts start this process with its output discarded, so the database is the only place a
      // record can last: `memesh doctor` reads it to tell an idle exit from a crash. A record that cannot
      // be written is said on stderr (which only a manual start shows) and never stops the exit.
      try { recordRouterIdleExit(database); } catch (error) {
        try { process.stderr.write(`MeMesh router: could not record its idle exit: ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* stderr gone */ }
      }
      void shutdown().finally(() => process.exit(0));
    },
  });
}).catch(reportFailure);
