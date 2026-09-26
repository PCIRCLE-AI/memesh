#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../db.js';
import { AgentRouter, AgentRouterError, AGENT_ROUTER_SOCKET_PATH_MAX_BYTES, type AgentHostRegistration } from '../core/agent-router.js';
import { createCodexCliQueueAdapter } from '../host-adapters/codex-cli-queue.js';
import { getAgentRouterSocketPath, getMemeshDirFromDbPath } from '../core/paths.js';
import { assertSecureLocalHostRuntimeSupported, ensureRouterTokenFile } from './config.js';

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
try {
  assertSecureLocalHostRuntimeSupported();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const expectedToken = ensureRouterTokenFile(tokenFile);

  const authenticate = (registration: AgentHostRegistration): boolean => {
    if (!registration.auth_token) return false;
    const actual = Buffer.from(registration.auth_token);
    const expected = Buffer.from(expectedToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  router = new AgentRouter({
    db: openDatabase(),
    socket_path: socketPath,
    adapters: [
      createCodexCliQueueAdapter({ authenticate }),
      ...['claude-channel', 'codex-app-server', 'acp'].map(kind => ({ kind, authenticate })),
    ],
  });
} catch (error) {
  reportFailure(error);
}

async function shutdown(): Promise<void> {
  await router.stop();
  closeDatabase();
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

router.start().catch(reportFailure);
