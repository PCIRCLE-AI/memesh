#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../db.js';
import { assertNodeSupported } from '../storage/sqlite.js';
import { AgentRouter, AgentRouterError, AGENT_ROUTER_SOCKET_PATH_MAX_BYTES } from '../core/agent-router.js';
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
function reportFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : undefined;
    const isSocketPathError = error instanceof AgentRouterError && error.code === 'invalid_socket_path';
    const detail = [
        code ? `code=${code}` : null,
        isSocketPathError
            ? `socket_path=${socketPath} (${Buffer.byteLength(socketPath)} bytes, limit ${AGENT_ROUTER_SOCKET_PATH_MAX_BYTES}${socketFromEnv ? ', from MEMESH_ROUTER_SOCKET' : ''})`
            : null,
    ].filter(Boolean).join(', ');
    try {
        process.stderr.write(`MeMesh router failed: ${message}${detail ? ` (${detail})` : ''}\n`);
    }
    catch { }
    try {
        closeDatabase();
    }
    catch { }
    process.exit(1);
}
let router;
let database;
try {
    assertNodeSupported();
    assertSecureLocalHostRuntimeSupported();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    requirePrivateWritableDirectory(dataDir, 'the router keeps its socket, token and messages there');
    const expectedToken = ensureRouterTokenFile(tokenFile);
    const authenticate = (registration) => {
        if (!registration.auth_token)
            return false;
        const actual = Buffer.from(registration.auth_token);
        const expected = Buffer.from(expectedToken);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    };
    const db = database = openDatabase();
    router = new AgentRouter({
        db,
        socket_path: socketPath,
        memesh_version: memeshPackageVersion(),
        on_superseded: () => { void shutdown().finally(() => process.exit(0)); },
        on_host_connected: () => {
            maybeStartNetworkBridge({ dataDir, dbPath: getDbPath(), db, networkDistDir: fileURLToPath(new URL('../network/', import.meta.url)) });
        },
        adapters: [
            createCodexCliQueueAdapter({ authenticate, release_watch: { db } }),
            ...['claude-channel', 'claude-inbox', 'codex-app-server', 'acp'].map(kind => ({ kind, authenticate })),
        ],
    });
}
catch (error) {
    reportFailure(error);
}
async function shutdown() {
    await router.stop();
    closeDatabase();
}
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
router.start().then(() => {
    const { idleMs, checkMs } = routerIdleSettings(process.env);
    watchRouterIdle({
        db: database,
        idleMs,
        checkMs,
        onIdle: () => {
            try {
                recordRouterIdleExit(database);
            }
            catch (error) {
                try {
                    process.stderr.write(`MeMesh router: could not record its idle exit: ${error instanceof Error ? error.message : String(error)}\n`);
                }
                catch { }
            }
            void shutdown().finally(() => process.exit(0));
        },
    });
}).catch(reportFailure);
//# sourceMappingURL=router.js.map