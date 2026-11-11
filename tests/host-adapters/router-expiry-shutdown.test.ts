import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { agentMessageExpiryCutoff } from '../../src/core/agent-message-ttl.js';

// The packaged router and CLI, started the way a host or a user starts them. `npm run build` (part of `npm run verify`) produces them.
const routerJs = fileURLToPath(new URL('../../dist/host-runtime/router.js', import.meta.url));
const cliJs = fileURLToPath(new URL('../../dist/transports/cli/cli.js', import.meta.url));
const ENTRIES = { router: [routerJs], 'memesh serve': [cliJs, 'serve', '--port', '0'] } as const;

describe.skipIf(process.platform === 'win32').each(Object.keys(ENTRIES) as Array<keyof typeof ENTRIES>)('the packaged %s stopped while it deletes expired messages', (entry) => {
  const children: ChildProcess[] = [];
  let base: string | undefined;

  afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    closeDatabase();
    if (base) fs.rmSync(base, { recursive: true, force: true });
    base = undefined;
  });

  function setup(expired: number) {
    // Short path: a Unix socket path is limited to about 100 bytes.
    base = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'mre-')); fs.chmodSync(base, 0o700);
    const dataDir = path.join(base, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
    const db = path.join(dataDir, 'knowledge-graph.db');
    openDatabase(db);
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    const insert = getDatabase().prepare(`
      INSERT INTO agent_messages (message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json, created_at)
      VALUES (?, 'p', 'alice', 'bob', 'text/plain', 'private', '"x"', '{}', ?)
    `);
    getDatabase().transaction(() => { for (let i = 0; i < expired; i++) insert.run(`m-${i}`, old); }).immediate();
    closeDatabase();
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: base, MEMESH_DB_PATH: db, MEMESH_ROUTER_SOCKET: path.join(base, 'r.sock'),
      MEMESH_ROUTER_TOKEN_FILE: path.join(dataDir, 'agent-router.token'),
    };
    const child = spawn(process.execPath, [...ENTRIES[entry]], { env, stdio: 'ignore' });
    children.push(child);
    const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
    return { db, child, exited };
  }

  function read<T>(db: string, sql: string): T {
    const handle = new DatabaseSync(db, { readOnly: true });
    try { return handle.prepare(sql).all() as T; } finally { handle.close(); }
  }

  it('exits at once, closes the pass it was running as interrupted and gives the lease back', async () => {
    const { db, child, exited } = setup(20_000);
    await vi.waitFor(() => {
      expect(read<Array<{ n: number }>>(db, "SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'started' AND expired_message_count > 0")[0].n).toBe(1);
    }, { timeout: 20_000, interval: 20 });
    const killedAt = Date.now();
    child.kill('SIGTERM');
    await exited;
    expect(Date.now() - killedAt).toBeLessThan(2_000);
    const runs = read<Array<{ outcome: string; expired_message_count: number }>>(db, 'SELECT outcome, expired_message_count FROM agent_message_expiry_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('interrupted');
    expect(runs[0].expired_message_count).toBeGreaterThan(0);
    expect(read<unknown[]>(db, 'SELECT * FROM agent_message_expiry_lease')).toEqual([]);
  }, 60_000);
});
