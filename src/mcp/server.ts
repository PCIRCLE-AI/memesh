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
import { openDatabase, closeDatabase } from '../db.js';
import { handleTool, TOOL_DEFINITIONS } from './tools.js';
import { configureVersionSource, normalizeClientHost } from '../transports/mcp/handlers.js';
import { resolveMcpProject } from '../transports/mcp/project-context.js';

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
  const needsWorkspaceRoots = needsProjectBinding || (name === 'work_package'
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
  const projectBinding = needsProjectBinding
    ? resolveMcpProject(process.env.MEMESH_PROJECT_ROOT, rootsUnreadable ? null : workspaceRootUris)
    : undefined;
  return handleTool(
    name,
    args,
    normalizeClientHost(server.getClientVersion()?.name),
    extra.signal,
    { workspaceRootUris, projectBinding },
  );
});

// Start
async function main() {
  openDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function shutdown() {
  try { closeDatabase(); } catch { /* best effort */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('MeMesh server error:', err instanceof Error ? err.message : String(err));
  try { closeDatabase(); } catch { /* best effort */ }
  process.exit(1);
});
