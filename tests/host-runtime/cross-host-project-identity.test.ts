import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  startClaudeManagedSession,
  type ClaudeManagedSessionDependencies,
} from '../../src/host-runtime/claude.js';
import { startCodexSessionCompanion } from '../../src/host-runtime/codex-session.js';
import type { ConnectRouterHostInput } from '../../src/host-runtime/router-client.js';

// #474 acceptance scenario: a Claude channel host and a Codex thread started
// in the SAME directory must register with the router under the identical
// project, so `message discover` (project-scoped) shows one agent to the
// other. There is no shared real-router test harness in this suite (every
// existing host-runtime test mocks `connect_router`/`connect` directly rather
// than dialing a live `dist/host-runtime/router.js`), so this proves the
// narrower, still load-bearing claim at the unit level: the two hosts'
// REGISTRATION IDENTITIES agree for one directory — the exact computation
// each would hand to a real router's `connect`. A true end-to-end run
// (two live processes, one router, `message discover` over the wire) is
// exercised interactively for Claude and automatically for Codex by
// `scripts/qa/live-journey.mjs`, never together in one process.
const threadId = '01a041b4-5c67-75b3-9505-4e33d7942b8e';

function fakeLifecycle(): ClaudeManagedSessionDependencies['lifecycle'] {
  return {
    addSignal() {},
    removeSignal() {},
    addInputClose() {},
    removeInputClose() {},
  };
}

describe.skipIf(process.platform === 'win32')('#474: cross-host discovery — one directory, one project', () => {
  it('a Claude channel host and an automatic Codex thread started in one directory compute the same registration project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cross-host-'));
    const previousDbPath = process.env.MEMESH_DB_PATH;
    try {
      let claudeProject: unknown;
      const claudeServer = {
        oninitialized: undefined as (() => void) | undefined,
        onclose: undefined as (() => void) | undefined,
        connect: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        notification: vi.fn(async () => undefined),
      };
      const claudeSession = await startClaudeManagedSession({
        server_name: 'memesh-channel-test',
        router_socket: '/private/tmp/memesh-cross-host-claude.sock',
        auth_token: 'claude-token',
        principal_id: 'claude-a',
      }, {
        server: claudeServer,
        transport: {} as never,
        lifecycle: fakeLifecycle(),
        connect_router: async (input) => {
          claudeProject = input.identity.project;
          return { connection_id: 'claude-connection', generation: 1, close: async () => undefined };
        },
        cwd: () => dir,
      });
      claudeServer.oninitialized?.();
      await claudeSession.registered;
      await claudeSession.close();

      process.env.MEMESH_DB_PATH = path.join(dir, 'memesh-data', 'knowledge-graph.db');
      let codexProject: unknown;
      await startCodexSessionCompanion(
        undefined,
        { hook_event_name: 'SessionStart', session_id: threadId, cwd: dir, source: 'startup' },
        { PLUGIN_ROOT: '/plugin' },
        {
          connect: async (input: ConnectRouterHostInput) => {
            codexProject = input.identity.project;
            return { connection_id: 'codex-connection', generation: 1, close: async () => undefined };
          },
        },
      );

      expect(claudeProject).toBeTypeOf('string');
      expect(claudeProject).toBe(codexProject);
    } finally {
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
