#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { startAgentMessageExpiryScheduler } from '../core/agent-message-expiry.js';
import { openDatabase, closeDatabase, getDatabase, isDatabaseOpen } from '../db.js';
import { databaseOpenFailureReport } from '../core/database-diagnosis.js';
import { handleTool, TOOL_DEFINITIONS } from './tools.js';
import { configureVersionSource, normalizeClientHost } from '../transports/mcp/handlers.js';
import { resolveMcpProject } from '../transports/mcp/project-context.js';
import { startClaudeInboxPresence } from '../host-runtime/claude-inbox.js';
import type { RouterHostConnection } from '../host-runtime/router-client.js';
import { accountMemeshDir, dispatchAutoUpdate, logAutoUpdateLine, registerLiveHost } from '../core/auto-update.js';
import { findPackageRoot } from '../core/package-root.js';
import { getDbPath, getMemeshDirFromDbPath } from '../core/paths.js';

// This file sits at the same depth (2 levels below the package root) both as
// TS source (src/mcp/server.ts) and inside the bundled dist/mcp/server.js
// esbuild produces, so this computation is correct in both contexts — unlike
// handlers.ts's own default, which esbuild bundles IN here from a different
// original depth. Handed to handlers.ts below so its notices read the right
// file instead of guessing (issue #426 review).
const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../package.json'
);
const packageVersion =
  JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version ?? '0.0.0';
configureVersionSource(packageVersion, packageJsonPath);

const server = new Server(
  { name: 'memesh', version: packageVersion },
  { capabilities: { tools: {} } }
);

let presence: RouterHostConnection | undefined;
let closing = false;
server.oninitialized = () => {
  if (normalizeClientHost(server.getClientVersion()?.name) !== 'claude-code') return;
  void (async () => {
    const roots = server.getClientCapabilities()?.roots
      ? (await server.listRoots(undefined, { timeout: 3000 })).roots.map(root => root.uri)
      : [];
    const connection = await startClaudeInboxPresence(roots);
    if (closing) await connection?.close();
    else presence = connection;
  })().catch(error => {
    // Registration is optional to core memory tools, but never silently green.
    console.error('[memesh] Claude online registration:', error instanceof Error ? error.message : String(error));
  });
};

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

// Call tool. The client's self-declared `initialize` name (claude-code,
// codex, gemini-cli, …) rides along as write provenance — the transport
// knows who is connected; the model must not be able to claim it.
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : undefined;
  const ref = record?.ref && typeof record.ref === 'object' ? record.ref as Record<string, unknown> : undefined;
  // The same blanks the handlers' schemas treat as absent: a client such as
  // Gemini CLI sends null for an optional field it leaves empty, and an empty
  // tag selects nothing.
  const needsProjectBinding = ((name === 'task_state' || name === 'briefing') && record?.project == null)
    // A write or recall that names its project (an id or false) needs no binding.
    || (name === 'learn' && record?.project == null)
    // `remember` is bound whenever `project` is not given, tags or not: a
    // `project:<plain name>` tag naming this session's own project is stored as
    // the project's id, and only the binding says which project that is. A
    // tagged write is never refused for lack of one (writeProject).
    || (name === 'remember' && record?.project == null)
    || (name === 'recall' && record?.project == null && (record?.tag == null || record.tag === '') && record?.cross_project !== true);
  // A call that names a project by id is still bound when the binding resolves: naming the
  // session's own project then reads (and may add to) every id its checkout was filed under,
  // as leaving it out does. A binding that cannot be resolved is not a refusal here: the
  // named id is used on its own.
  const namesProject = typeof record?.project === 'string'
    && ['recall', 'remember', 'learn', 'task_state', 'briefing'].includes(name);
  const wantsBinding = needsProjectBinding || namesProject;
  const needsWorkspaceRoots = wantsBinding || (name === 'work_package'
    && (record?.kind === 'transcript' || ref?.kind === 'transcript'));
  let workspaceRootUris: string[] = [];
  // Advertised roots that could not be read: work_package treats them as none,
  // as before; the project binding refuses instead of trusting the launch root alone.
  let rootsUnreadable = false;
  if (needsWorkspaceRoots) {
    if (!server.getClientCapabilities()?.roots) {
      workspaceRootUris = [];
    } else {
      try {
        const listed = await server.listRoots(undefined, {
          signal: extra.signal,
          timeout: 3_000,
          maxTotalTimeout: 3_000,
        });
        workspaceRootUris = listed.roots.map(root => root.uri);
      } catch {
        workspaceRootUris = [];
        rootsUnreadable = true;
      }
    }
  }
  // MEMESH_PROJECT_ROOT is set by whoever launched the host for one project;
  // it binds the call alongside the client's roots, never instead of a conflict.
  const projectBinding = wantsBinding
    ? resolveMcpProject(process.env.MEMESH_PROJECT_ROOT, rootsUnreadable ? null : workspaceRootUris)
    : undefined;
  return handleTool(
    name,
    args,
    normalizeClientHost(server.getClientVersion()?.name),
    extra.signal,
    {
      workspaceRootUris, projectBinding,
      ...(server.getClientCapabilities()?.elicitation?.form ? {
        elicit: (params: import('@modelcontextprotocol/sdk/types.js').ElicitRequestFormParams) =>
          server.elicitInput(params, { signal: extra.signal, timeout: 120_000 }),
      } : {}),
    },
  );
});

// Start
// Agent messages are kept one day (core/agent-message-expiry.ts). This server
// is a long-lived process with the database open, so it runs the pass too.
let stopExpiry: () => void = () => undefined;

async function main() {
  // The agent that started this server is a running host: the updater waits
  // for it to exit before it replaces any file (this covers hosts with no hooks).
  try {
    // Registered where every data directory looks (the account's own ~/.memesh): the program an update replaces is shared by all of them.
    registerLiveHost(accountMemeshDir() ?? getMemeshDirFromDbPath(), undefined, getMemeshDirFromDbPath());
  } catch (err) {
    // Not fatal for the server, but the updater cannot see this host and may replace files under it: say so.
    logAutoUpdateLine(getMemeshDirFromDbPath(), `auto-update: could not register this MCP host (${err instanceof Error ? err.message : String(err)}); the updater may not wait for it`);
  }
  try {
    openDatabase();
  } catch (err) {
    // stderr only: stdout is the MCP protocol channel.
    console.error(databaseOpenFailureReport(err, getDbPath()));
    throw err;
  }
  stopExpiry = startAgentMessageExpiryScheduler(() => (isDatabaseOpen() ? getDatabase() : null), { trigger: 'mcp-server' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // A host that wires only this server runs no SessionStart hook, so nothing else would start the updater there. It is the same
  // single entry the hooks and `memesh serve` use: its own throttle, lock and policy decide whether anything happens.
  try {
    void dispatchAutoUpdate(findPackageRoot(import.meta.url)).catch((err) => {
      logAutoUpdateLine(getMemeshDirFromDbPath(), `auto-update: the MCP server could not start the updater (${err instanceof Error ? err.message : String(err)})`);
    });
  } catch (err) {
    logAutoUpdateLine(getMemeshDirFromDbPath(), `auto-update: the MCP server could not start the updater (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function shutdown() {
  if (closing) return;
  closing = true;
  stopExpiry();
  await presence?.close();
  try { closeDatabase(); } catch { /* best effort */ }
  process.exit(0);
}
server.onclose = () => { void shutdown(); };
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

main().catch((err) => {
  console.error('MeMesh server error:', err instanceof Error ? err.message : String(err));
  try { closeDatabase(); } catch { /* best effort */ }
  process.exit(1);
});
