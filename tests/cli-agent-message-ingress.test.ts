import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../src/db.js';
import { AGENT_MESSAGE_PROJECT_TABLES } from '../src/core/agent-scope-id.js';
import { pollAgentEvents, sendAgentMessage } from '../src/core/agent-messaging.js';
import { readCliMessagePayloadFromStdin } from '../src/transports/cli/cli.js';

const cliLoader = `
  import { createServer } from 'vite';
  const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts');
    await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]);
  } finally {
    await server.close();
  }
`;

function cliArgs(...args: string[]): string[] {
  return ['--input-type=module', '--eval', cliLoader, ...args];
}

function readOwnerPrivateRegularFile(filePath: string): string {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o077).toBe(0);
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

describe('CLI message payload from stdin', () => {
  it('keeps a multi-byte character that is split across two stdin writes intact', async () => {
    const bytes = Buffer.from('hi 你好', 'utf8');
    // 你 is three bytes starting at offset 3; cutting at 4 leaves it half in each chunk.
    const stdin = Readable.from([bytes.subarray(0, 4), bytes.subarray(4)], { objectMode: true });
    await expect(readCliMessagePayloadFromStdin('text/plain', stdin)).resolves.toBe('hi 你好');
  });

  it('counts the limit in bytes of what was written, whatever the chunking', async () => {
    const stdin = Readable.from([Buffer.alloc(40_000, 'x'), Buffer.alloc(40_000, 'x')], { objectMode: true });
    await expect(readCliMessagePayloadFromStdin('text/plain', stdin)).rejects.toThrow(/exceeds 65536 UTF-8 bytes/);
  });
});

describe('CLI durable-message ingress', () => {
  it('documents the separate durable payload and complete native envelope limits', () => {
    const result = spawnSync(process.execPath, cliArgs('message', 'send', '--help'), {
      encoding: 'utf8',
      env: { ...process.env, MEMESH_AUTO_CAPTURE: 'false' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('payload 64 KiB');
    expect(result.stdout).toMatch(/complete native\s+envelope 16 KiB/);
    expect(result.stdout).toContain('65536 UTF-8 bytes');
    expect(result.stdout).toContain('16384');
    expect(result.stdout).toContain('untrusted');
  });

  it('accepts JSON from stdin through the current source CLI', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    const payload = JSON.stringify({ kind: 'stdin-happy-path', value: 7 });
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'recipient', '--idempotency-key', 'stdin-happy-json', '--payload-stdin',
        '--content-type', 'application/json',
      ), {
        encoding: 'utf8',
        input: payload,
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status, result.stderr).toBe(0);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({
        project: 'test', sender: 'sender', recipient: 'recipient', target_kind: 'principal',
        content_type: 'application/json',
      });
      expect(typeof response.message_id).toBe('string');
      expect(result.stdout).not.toContain(payload);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#497: sends a principal message meant for one session, and only that session (CLAUDE_CODE_SESSION_ID) can record intake', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-intended-'));
    const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const env = (session?: string) => ({
      ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', CLAUDE_CODE_SESSION_ID: session,
    });
    try {
      const sent = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'lead', '--recipient', 'claude-test-1',
        '--intended-session', sessionA, '--idempotency-key', 'intended-cli', '--payload-stdin',
      ), { encoding: 'utf8', input: 'for owner A', env: env() });
      expect(sent.status, sent.stderr).toBe(0);
      const message = JSON.parse(sent.stdout) as { message_id: string; intended_session: string };
      expect(message.intended_session).toBe(sessionA);

      const intake = (session: string) => spawnSync(process.execPath, cliArgs(
        'message', 'intake', '--project', 'test', '--recipient', 'claude-test-1',
        '--message-id', message.message_id, '--idempotency-key', `intake-${message.message_id}`, '--state', 'ingested',
      ), { encoding: 'utf8', env: env(session) });
      const asB = intake(sessionB);
      expect(asB.status).toBe(1);
      expect(asB.stderr).toContain('intended_for_other_session');
      const asA = intake(sessionA);
      expect(asA.status, asA.stderr).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#497: a registered Codex CLI thread can be named, and records intake from its shell (CODEX_THREAD_ID); no session id is refused with the CLI hint', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-codex-intended-'));
    const dbPath = path.join(home, 'graph.db');
    const thread = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    // The same row codex-session.ts writes: the thread id is the session id.
    const db = openDatabase(dbPath);
    db.prepare(`INSERT INTO agent_principals (project, principal_id, activation_event_sequence) VALUES ('test', 'codex-lead', 0)`).run();
    db.prepare(`
      INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind)
      VALUES ('test', ?, 'codex-lead', 'codex-cli-queue')
    `).run(thread);
    closeDatabase();
    const env = (vars: Record<string, string | undefined>) => ({
      ...process.env, HOME: home, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: 'false',
      CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined, ...vars,
    });
    try {
      const sent = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'claude-lead', '--recipient', 'codex-lead',
        '--intended-session', thread, '--idempotency-key', 'codex-intended', '--payload-stdin',
      ), { encoding: 'utf8', input: 'for the codex thread', env: env({}) });
      expect(sent.status, sent.stderr).toBe(0);
      const message = JSON.parse(sent.stdout) as { message_id: string; intended_session: string };
      expect(message.intended_session).toBe(thread);

      const intake = (vars: Record<string, string | undefined>) => spawnSync(process.execPath, cliArgs(
        'message', 'intake', '--project', 'test', '--recipient', 'codex-lead',
        '--message-id', message.message_id, '--idempotency-key', `intake-${message.message_id}`, '--state', 'ingested',
      ), { encoding: 'utf8', env: env(vars) });
      const noSession = intake({});
      expect(noSession.status).toBe(1);
      expect(noSession.stderr).toContain('intended_for_other_session');
      expect(noSession.stderr).toContain('memesh message intake');
      const fromShell = intake({ CODEX_THREAD_ID: thread });
      expect(fromShell.status, fromShell.stderr).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#497: --fallback-to-principal is refused without --target-kind session', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-fallback-'));
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'lead', '--recipient', 'claude-test-1',
        '--fallback-to-principal', '--idempotency-key', 'fallback-cli', '--payload-stdin',
      ), { encoding: 'utf8', input: 'x', env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fallback_to_principal is only valid with target_kind');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('enforces the durable limit after JSON encoding for plain text', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-limit-'));
    try {
      const accepted = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'recipient', '--idempotency-key', 'plain-limit-accepted', '--payload-stdin',
      ), {
        encoding: 'utf8',
        input: 'x'.repeat(65_534),
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(accepted.status, accepted.stderr).toBe(0);

      const rejected = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'recipient', '--idempotency-key', 'plain-limit-rejected', '--payload-stdin',
      ), {
        encoding: 'utf8',
        input: 'x'.repeat(65_535),
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('payload must be at most 65536 UTF-8 bytes when encoded as JSON');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports router_unreachable when the sender cannot reach the router while preserving scoped recovery', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'session-instance-9', '--target-kind', 'session',
        '--idempotency-key', 'stdin-exact-session', '--payload-stdin',
      ), {
        encoding: 'utf8',
        input: 'exact session only',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('router_unreachable');
      expect(result.stdout).toBe('');

      const polled = spawnSync(process.execPath, cliArgs(
        'message', 'watch', '--project', 'test', '--recipient', 'session-instance-9',
        '--wait-ms', '0',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(polled.status, polled.stderr).toBe(0);
      const lines = polled.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      const eventBatch = lines.at(-1) as { events: Array<{ message_id: string; target_kind: string }> };
      expect(eventBatch.events[0]).toMatchObject({ target_kind: 'session' });
      const messageId = eventBatch.events[0].message_id;

      const fetched = spawnSync(process.execPath, cliArgs(
        'message', 'fetch', '--project', 'test', '--recipient', 'session-instance-9',
        '--target-kind', 'session', '--message-id', messageId,
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(fetched.status, fetched.stderr).toBe(0);
      expect(JSON.parse(fetched.stdout)).toMatchObject({
        message_id: messageId,
        recipient: 'session-instance-9',
        target_kind: 'session',
        payload: 'exact session only',
      });

      const wrongKind = spawnSync(process.execPath, cliArgs(
        'message', 'fetch', '--project', 'test', '--recipient', 'session-instance-9',
        '--target-kind', 'principal', '--message-id', messageId,
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(wrongKind.status).not.toBe(0);
      expect(wrongKind.stderr).toContain('not available');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported --target-kind before reading or persisting payload', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'session-instance-9', '--target-kind', 'replacement',
        '--idempotency-key', 'invalid-target-kind', '--payload-stdin',
      ), {
        encoding: 'utf8',
        input: 'must not persist',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--target-kind "replacement" is not valid. Use one of: principal, session.');
      expect(result.stdout).toBe('');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects payload argv and requires the stdin-only flag', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'recipient', '--idempotency-key', 'one', '--payload-stdin',
        '--payload', 'sentinel-must-not-be-logged',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unknown option '--payload'/);
      expect(`${result.stdout}${result.stderr}`).not.toContain('sentinel-must-not-be-logged');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // #403: the policy the report prints is the cutoff it applied. A cutoff in
  // SQLite's form is UTC; printing it through `new Date()` showed it eight
  // hours off at UTC+8.
  it('#403 report prints the cutoff it applied, for a cutoff in SQLite form under a non-UTC TZ', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    try {
      const report = spawnSync(process.execPath, cliArgs(
        'message', 'storage', 'report', '--cutoff', '2026-08-27 00:00:00',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', TZ: 'Asia/Taipei' },
      });
      expect(report.status, report.stderr).toBe(0);
      expect(JSON.parse(report.stdout).policy.cutoff).toBe('2026-08-27T00:00:00.000Z');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports storage and keeps prune dry-run non-mutating by default', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    const cutoff = '2026-08-27T00:00:00.000Z';
    try {
      const report = spawnSync(process.execPath, cliArgs(
        'message', 'storage', 'report', '--cutoff', cutoff,
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(report.status, report.stderr).toBe(0);
      expect(JSON.parse(report.stdout)).toMatchObject({
        policy: { cutoff, quota_bytes: null, automatic_pruning: false },
        message_count: 0,
        protected_unresolved_message_count: 0,
      });

      const dryRun = spawnSync(process.execPath, cliArgs(
        'message', 'storage', 'prune', '--cutoff', cutoff, '--batch-size', '1',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(JSON.parse(dryRun.stdout)).toEqual({
        dry_run: true,
        candidate_count: 0,
        tombstoned_count: 0,
        reclaimed_payload_bytes: 0,
        candidates: [],
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a filesystem path as --project or --principal, before writing any config', () => {
    // `memesh agent setup` is the fourth producer of a routing identity, and
    // the only one outside the message tool. `send` refuses a path-shaped
    // project or recipient, so a host configured under one would register a
    // principal nothing can address — and the failure would surface as an
    // error about a SENDER's argument, later, somewhere else.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-'));
    try {
      for (const [flag, value] of [['--project', '/Users/x/Projects/repo'], ['--principal', '/root']] as const) {
        const args = ['agent', 'setup', 'codex', '--project', 'test', '--principal', 'reviewer', '--workspace', home];
        args[args.indexOf(flag) + 1] = value;
        const setup = spawnSync(process.execPath, cliArgs(...args), {
          encoding: 'utf8',
          env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
        });
        expect(setup.status, setup.stdout).not.toBe(0);
        expect(setup.stderr).toContain(`${flag}:`);
        expect(setup.stderr).toContain('must be a stable identifier, not a filesystem path');
      }
      expect(fs.existsSync(path.join(home, '.memesh', 'hosts', 'codex.json'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: kg rename-project --apply backs up next to the database, not in the current directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-backup-'));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'seed-519', '--type', 'note', '--obs', 'x', '--tags', 'project:old-519',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const rename = spawnSync(process.execPath, cliArgs(
        'kg', 'rename-project', '--from', 'old-519', '--to', 'new-519', '--apply', '--json',
      ), { encoding: 'utf8', env });
      expect(rename.status, rename.stderr).toBe(0);
      const { backupPath } = JSON.parse(rename.stdout) as { backupPath: string };
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.realpathSync(path.dirname(path.dirname(backupPath)))).toBe(fs.realpathSync(path.join(home, '.memesh')));
      expect(path.resolve(backupPath).startsWith(path.resolve(process.cwd()) + path.sep)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: kg rename-project --from X --to X is refused with one line and exit 1', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-same-'));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'seed-same', '--type', 'note', '--obs', 'x', '--tags', 'project:same-519',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      for (const extra of [[], ['--apply']]) {
        const r = spawnSync(process.execPath, cliArgs(
          'kg', 'rename-project', '--from', 'same-519', '--to', 'same-519', ...extra,
        ), { encoding: 'utf8', env });
        expect(r.status).toBe(1);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
        expect(r.stderr).toContain('same project');
        expect(r.stderr).not.toContain('    at ');
      }
      const list = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--json'), { encoding: 'utf8', env });
      expect(list.stdout).toContain('same-519');
      expect(fs.existsSync(path.join(home, '.memesh', 'backups'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: a rename-project dry run persists nothing, not even auto-decay', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-dry-'));
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'stale-dry', '--type', 'note', '--obs', 'x', '--tags', 'project:dry-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
      const writer = new DatabaseSync(dbFile);
      writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'stale-dry'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
      writer.close();
      const dry = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--from', 'dry-old', '--to', 'dry-new'), { encoding: 'utf8', env });
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain('Nothing written');
      const reader = new DatabaseSync(dbFile, { readOnly: true });
      try {
        expect((reader.prepare("SELECT confidence FROM entities WHERE name = 'stale-dry'").get() as { confidence: number }).confidence).toBe(0.8);
        expect(reader.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get()).toBeUndefined();
      } finally {
        reader.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: list mode and incomplete --from/--to never write to the database', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-ro-'));
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'stale-ro', '--type', 'note', '--obs', 'x', '--tags', 'project:ro-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
      const writer = new DatabaseSync(dbFile);
      writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'stale-ro'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
      writer.close();
      const snapshot = () => {
        const reader = new DatabaseSync(dbFile, { readOnly: true });
        try {
          return {
            entities: reader.prepare('SELECT name, confidence, last_accessed_at FROM entities ORDER BY id').all(),
            metadata: reader.prepare('SELECT key, value FROM memesh_metadata ORDER BY key').all(),
            schema: reader.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all(),
          };
        } finally {
          reader.close();
        }
      };
      const before = snapshot();
      expect(before.metadata.some((m) => (m as { key: string }).key === 'last_decay_at')).toBe(false);

      for (const args of [[], ['--json']]) {
        const list = spawnSync(process.execPath, cliArgs('kg', 'rename-project', ...args), { encoding: 'utf8', env });
        expect(list.status, list.stderr).toBe(0);
        expect(list.stdout).toContain('ro-old');
        expect(snapshot()).toEqual(before);
      }
      for (const args of [['--from', 'ro-old'], ['--to', 'ro-new'], ['--from', 'ro-old', '--apply'], ['--to', 'ro-new', '--apply']]) {
        const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', ...args), { encoding: 'utf8', env });
        expect(r.status).toBe(1);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
        expect(r.stderr).toMatch(/^Error: .*--from and --to/);
        expect(snapshot()).toEqual(before);
      }
      expect(fs.existsSync(path.join(home, '.memesh', 'backups'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // A database prepared in-process (openDatabase takes a path), then driven through the CLI.
  function seedMessageScopes(home: string, extra: (db: ReturnType<typeof openDatabase>) => void = () => {}): string {
    const dbFile = path.join(home, 'seeded.db');
    const db = openDatabase(dbFile);
    try {
      const send = (project: string, key: string) => sendAgentMessage(db, {
        project, sender: 'author', recipient: 'reviewer', idempotency_key: key,
        content_type: 'text/plain', payload: `p-${key}`,
      });
      send('mv-old', 'shared');
      send('mv-old', 'only-old');
      send('mv-new', 'shared');
      extra(db);
    } finally {
      closeDatabase();
    }
    return dbFile;
  }
  const rename = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(
    process.execPath, cliArgs('kg', 'rename-project', '--from', 'mv-old', '--to', 'mv-new', ...args), { encoding: 'utf8', env });

  it('#519: the preview counts the same collisions as --apply when a unique index is still to be created', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-idx-'));
    try {
      const dbFile = seedMessageScopes(home, (db) => {
        const polled = pollAgentEvents(db, { project: 'mv-old', recipient: 'reviewer' });
        const cursor = db.prepare('SELECT * FROM agent_message_cursors WHERE cursor_token = ?').get(polled.next_cursor) as { event_sequence: number; created_at: string };
        db.prepare('INSERT INTO agent_message_cursors VALUES (?,?,?,?,?)').run('dest-token', 'mv-new', 'reviewer', cursor.event_sequence, cursor.created_at);
        db.exec('DROP INDEX idx_agent_message_cursors_unique_scope_sequence');
      });
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', MEMESH_DB_PATH: dbFile };
      const scopeRows = (scope: string) => {
        const reader = new DatabaseSync(dbFile, { readOnly: true });
        try {
          return AGENT_MESSAGE_PROJECT_TABLES.reduce(
            (n, t) => n + (reader.prepare(`SELECT count(*) AS n FROM ${t} WHERE project = ?`).get(scope) as { n: number }).n, 0);
        } finally {
          reader.close();
        }
      };
      const preview = rename(env, '--json');
      expect(preview.status, preview.stderr).toBe(0);
      const newBefore = scopeRows('mv-new');
      expect(scopeRows('mv-old')).toBe(JSON.parse(preview.stdout).messageRows);
      const apply = rename(env, '--apply', '--json');
      expect(apply.status, apply.stderr).toBe(0);
      const p = JSON.parse(preview.stdout);
      const a = JSON.parse(apply.stdout);
      expect(p.messageRowsBlocked).toBeGreaterThan(0);
      expect(p.messageRowsBlocked).toBe(a.messageRowsBlocked);
      expect(p.messageRows).toBe(a.messageRows);
      // The database read back after the apply reconciles both numbers.
      expect(scopeRows('mv-old')).toBe(a.messageRowsBlocked);
      expect(scopeRows('mv-new') - newBefore).toBe(a.messageRows - a.messageRowsBlocked);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // The preview runs the real apply on a throwaway copy, so it agrees with --apply
  // for any index the database carries: partial, collated, expression, or non-unique.
  describe('#519: preview and apply agree on whatever constraints the database has', () => {
    const cases: Array<[string, string, string, string]> = [
      ['a partial UNIQUE index keeps its predicate', "CREATE UNIQUE INDEX extra_partial ON agent_message_cursors(project,event_sequence) WHERE recipient='special'", 'alpha', 'beta'],
      ['a NOCASE UNIQUE index keeps its collation', 'DROP INDEX idx_agent_message_cursors_unique_scope_sequence; CREATE UNIQUE INDEX idx_agent_message_cursors_unique_scope_sequence ON agent_message_cursors(project,recipient COLLATE NOCASE,event_sequence)', 'Reviewer', 'reviewer'],
      ['a same-name NON-unique index stays non-unique', 'DROP INDEX idx_agent_message_cursors_unique_scope_sequence; CREATE INDEX idx_agent_message_cursors_unique_scope_sequence ON agent_message_cursors(project,recipient,event_sequence)', 'reviewer', 'reviewer'],
      ['an expression UNIQUE index compares its expression', 'CREATE UNIQUE INDEX extra_expression ON agent_message_cursors(project,lower(recipient),event_sequence)', 'alpha', 'beta'],
    ];
    for (const [name, indexSql, oldRecipient, newRecipient] of cases) {
      it(name, () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-constraint-'));
        try {
          const dbFile = path.join(home, 'seeded.db');
          const db = openDatabase(dbFile);
          try {
            const insert = db.prepare('INSERT INTO agent_message_cursors VALUES (?,?,?,?,?)');
            insert.run('old-probe', 'mv-old', oldRecipient, 42, '2026-09-30');
            insert.run('new-probe', 'mv-new', newRecipient, 42, '2026-09-30');
            db.exec(indexSql);
          } finally {
            closeDatabase();
          }
          const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', MEMESH_DB_PATH: dbFile };
          const digest = () => createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
          const before = digest();
          const preview = rename(env, '--json');
          expect(preview.status, preview.stderr).toBe(0);
          expect(digest()).toBe(before);
          const apply = rename(env, '--apply', '--json');
          expect(apply.status, apply.stderr).toBe(0);
          const p = JSON.parse(preview.stdout);
          const a = JSON.parse(apply.stdout);
          expect(p.messageRowsBlocked).toBe(a.messageRowsBlocked);
          expect(p.messageRows).toBe(a.messageRows);
          const reader = new DatabaseSync(dbFile, { readOnly: true });
          try {
            expect((reader.prepare("SELECT count(*) AS n FROM agent_message_cursors WHERE project = 'mv-old'").get() as { n: number }).n).toBe(a.messageRowsBlocked);
          } finally {
            reader.close();
          }
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
        }
      });
    }

    for (const [name, trigger, otherTag] of [
      ['an ignored tag UPDATE', 'CREATE TRIGGER ignore_tag BEFORE UPDATE OF tag ON tags BEGIN SELECT RAISE(IGNORE); END', false],
      ['an ignored tag DELETE (a merge)', 'CREATE TRIGGER ignore_tag_delete BEFORE DELETE ON tags BEGIN SELECT RAISE(IGNORE); END', true],
    ] as const) {
      it(`${name} fails and rolls back instead of splitting a memory from its messages`, () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-tagignore-'));
        try {
          const dbFile = seedMessageScopes(home, (db) => {
            const entity = db.prepare("INSERT INTO entities (name, type) VALUES ('tag-ignore', 'note')").run();
            const addTag = db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)');
            addTag.run(entity.lastInsertRowid, 'project:mv-old');
            if (otherTag) addTag.run(entity.lastInsertRowid, 'project:mv-new');
            db.exec(trigger);
          });
          const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', MEMESH_DB_PATH: dbFile };
          const state = () => {
            const reader = new DatabaseSync(dbFile, { readOnly: true });
            try {
              return {
                tags: reader.prepare('SELECT tag FROM tags ORDER BY tag').all(),
                scopes: AGENT_MESSAGE_PROJECT_TABLES.map((t) => reader.prepare(`SELECT project, count(*) AS n FROM ${t} GROUP BY project ORDER BY project`).all()),
              };
            } finally {
              reader.close();
            }
          };
          const before = state();
          for (const extra of [[], ['--apply']]) {
            const r = rename(env, ...extra);
            expect(r.status).toBe(1);
            expect(r.stderr.trim().split('\n')).toHaveLength(1);
            expect(r.stderr).toContain('(a trigger or constraint changed the result)');
            // One sentence: the reason, then what happened, not two endings.
            expect(r.stderr).not.toMatch(/\.\s+—/);
            expect(r.stderr).not.toContain('    at ');
            expect(state()).toEqual(before);
          }
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
        }
      });
    }

    it('an update that a trigger silently ignores fails and rolls back, in the preview and in --apply', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-ignore-'));
      try {
        const dbFile = seedMessageScopes(home, (db) => {
          db.exec("CREATE TRIGGER ignore_move BEFORE UPDATE OF project ON agent_messages BEGIN SELECT RAISE(IGNORE); END");
        });
        const tmp = path.join(home, 'tmp');
        fs.mkdirSync(tmp);
        const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', MEMESH_DB_PATH: dbFile, TMPDIR: tmp };
        const scopes = () => {
          const reader = new DatabaseSync(dbFile, { readOnly: true });
          try {
            return AGENT_MESSAGE_PROJECT_TABLES.map((t) => reader.prepare(`SELECT project, count(*) AS n FROM ${t} GROUP BY project ORDER BY project`).all());
          } finally {
            reader.close();
          }
        };
        const before = scopes();
        for (const extra of [[], ['--apply']]) {
          const r = rename(env, ...extra);
          expect(r.status).toBe(1);
          expect(r.stderr.trim().split('\n')).toHaveLength(1);
          expect(r.stderr).not.toContain('    at ');
          expect(scopes()).toEqual(before);
          // The preview's throwaway copy is deleted on the failure path too.
          expect(fs.readdirSync(tmp).filter((n) => n.startsWith('memesh-rename-preview-'))).toEqual([]);
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('#519: the printed message counts equal what was moved and what was left', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-count-'));
    try {
      const dbFile = seedMessageScopes(home);
      const tmp = path.join(home, 'tmp');
      fs.mkdirSync(tmp);
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', MEMESH_DB_PATH: dbFile, TMPDIR: tmp };
      const p = JSON.parse(rename(env, '--json').stdout);
      // The preview's throwaway copy is deleted when the preview succeeds.
      expect(fs.readdirSync(tmp).filter((n) => n.startsWith('memesh-rename-preview-'))).toEqual([]);
      expect(p.messageRowsBlocked).toBeGreaterThan(0);
      const moved = p.messageRows - p.messageRowsBlocked;
      const dry = rename(env);
      expect(dry.stdout).toContain(`${moved} durable agent-message row(s) scoped to mv-old would move to mv-new, ${p.messageRowsBlocked} would be left in place`);
      const apply = rename(env, '--apply');
      expect(apply.status, apply.stderr).toBe(0);
      expect(apply.stdout).toContain(`${moved} agent-message row(s) moved, ${p.messageRowsBlocked} left in place`);
      const reader = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const left = AGENT_MESSAGE_PROJECT_TABLES.reduce(
          (n, t) => n + (reader.prepare(`SELECT count(*) AS n FROM ${t} WHERE project = 'mv-old'`).get() as { n: number }).n, 0);
        expect(left).toBe(p.messageRowsBlocked);
      } finally {
        reader.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: a refused same-name rename leaves the database untouched, even with --apply', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-same-ro-'));
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'stale-same', '--type', 'note', '--obs', 'x', '--tags', 'project:same-ro',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
      const writer = new DatabaseSync(dbFile);
      writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'stale-same'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
      writer.close();
      for (const extra of [[], ['--apply']]) {
        const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--from', 'same-ro', '--to', 'same-ro', ...extra), { encoding: 'utf8', env });
        expect(r.status).toBe(1);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
        expect(r.stderr).toContain('same project');
        const reader = new DatabaseSync(dbFile, { readOnly: true });
        try {
          expect((reader.prepare("SELECT confidence FROM entities WHERE name = 'stale-same'").get() as { confidence: number }).confidence).toBe(0.8);
          expect(reader.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get()).toBeUndefined();
        } finally {
          reader.close();
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: with no database yet, listing says so and exits 0, and nothing is created', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-nodb-'));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const list = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout).toContain('No MeMesh database yet');
      const json = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--json'), { encoding: 'utf8', env });
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
      const dry = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--from', 'a', '--to', 'b'), { encoding: 'utf8', env });
      expect(dry.status).toBe(1);
      expect(dry.stderr.trim().split('\n')).toHaveLength(1);
      expect(dry.stderr).toContain('No MeMesh database');
      expect(fs.existsSync(path.join(home, '.memesh', 'knowledge-graph.db'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('#519: list and dry run work on a database in a read-only directory, and change nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-rodir-'));
    const dir = path.join(home, '.memesh');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'ro-dir', '--type', 'note', '--obs', 'x', '--tags', 'project:rodir-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(dir, 'knowledge-graph.db');
      expect(fs.existsSync(`${dbFile}-wal`)).toBe(false);
      const state = () => ({
        db: createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex'),
        files: fs.readdirSync(dir).sort(),
      });
      const before = state();
      fs.chmodSync(dir, 0o555);
      try {
        for (const args of [[], ['--json'], ['--from', 'rodir-old', '--to', 'rodir-new']]) {
          const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', ...args), { encoding: 'utf8', env });
          expect(r.status, r.stderr).toBe(0);
          expect(r.stderr).toBe('');
          expect(r.stdout).toContain('rodir-old');
          expect(state()).toEqual(before);
        }
        // An EMPTY write-ahead log holds no changes, so it is read as immutable too.
        fs.chmodSync(dir, 0o755);
        fs.writeFileSync(`${dbFile}-wal`, Buffer.alloc(0));
        fs.chmodSync(dir, 0o555);
        const emptyWal = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
        expect(emptyWal.status, emptyWal.stderr).toBe(0);
        expect(emptyWal.stdout).toContain('rodir-old');
        expect(state().db).toBe(before.db);
        // A write-ahead log that may hold unread changes is not read as immutable: one line, exit 1.
        fs.chmodSync(dir, 0o755);
        fs.writeFileSync(`${dbFile}-wal`, Buffer.alloc(32));
        fs.chmodSync(dir, 0o555);
        const refused = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
        expect(refused.status).toBe(1);
        expect(refused.stderr.trim().split('\n')).toHaveLength(1);
        expect(refused.stderr).not.toContain('    at ');
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('#519: a symlinked database path finds the real write-ahead log, so a non-empty one is never read as immutable', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-symlink-'));
    const dir = path.join(home, '.memesh');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'link-seed', '--type', 'note', '--obs', 'x', '--tags', 'project:link-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const link = path.join(home, 'link.db');
      fs.symlinkSync(path.join(dir, 'knowledge-graph.db'), link);
      const linked = { ...env, MEMESH_DB_PATH: link };
      fs.chmodSync(dir, 0o555);
      try {
        // No write-ahead log: nothing unread, so the immutable read works through the link.
        const clean = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env: linked });
        expect(clean.status, clean.stderr).toBe(0);
        expect(clean.stdout).toContain('link-old');
        // A non-empty log beside the REAL file may hold changes the immutable read would miss.
        fs.chmodSync(dir, 0o755);
        fs.writeFileSync(path.join(dir, 'knowledge-graph.db-wal'), Buffer.alloc(32));
        fs.chmodSync(dir, 0o555);
        const refused = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env: linked });
        expect(refused.status).toBe(1);
        expect(refused.stderr.trim().split('\n')).toHaveLength(1);
        expect(refused.stderr).not.toContain('    at ');
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: listing a database with no tags table is one line and exit 1, not a stack trace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-empty-'));
    try {
      const dir = path.join(home, '.memesh');
      fs.mkdirSync(dir);
      const dbFile = path.join(dir, 'knowledge-graph.db');
      const empty = new DatabaseSync(dbFile);
      empty.exec('CREATE TABLE unrelated (a)');
      empty.close();
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
      expect(r.status).toBe(1);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).not.toContain('    at ');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: --apply without --from and --to is refused before the database is opened', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-applyonly-'));
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'stale-applyonly', '--type', 'note', '--obs', 'x', '--tags', 'project:applyonly',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
      const writer = new DatabaseSync(dbFile);
      writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'stale-applyonly'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
      writer.close();
      const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--apply'), { encoding: 'utf8', env });
      expect(r.status).toBe(1);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain('--apply');
      const reader = new DatabaseSync(dbFile, { readOnly: true });
      try {
        expect((reader.prepare("SELECT confidence FROM entities WHERE name = 'stale-applyonly'").get() as { confidence: number }).confidence).toBe(0.8);
        expect(reader.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get()).toBeUndefined();
      } finally {
        reader.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: a refused --to is one line and exit 1, not a stack trace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-badto-'));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      for (const extra of [[], ['--apply']]) {
        const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--from', 'old', '--to', '/tmp/bad', ...extra), { encoding: 'utf8', env });
        expect(r.status).toBe(1);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
        expect(r.stderr).toContain('--to');
        expect(r.stderr).not.toContain('    at ');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // Runs the printed restore command, so it needs the sqlite3 binary.
  const hasSqlite3 = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(process.platform === 'win32' || !hasSqlite3)('#519: the backup is owner-only and the printed restore command works for an awkward path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memesh cli it's \"odd\" $x-"));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'seed-odd', '--type', 'note', '--obs', 'x', '--tags', 'project:odd-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const rename = spawnSync(process.execPath, cliArgs(
        'kg', 'rename-project', '--from', 'odd-old', '--to', 'odd-new', '--apply',
      ), { encoding: 'utf8', env });
      expect(rename.status, rename.stderr).toBe(0);
      const backupLine = rename.stdout.split('\n').find((l) => l.trim().startsWith('Backup:'))!;
      const backupPath = backupLine.trim().slice('Backup: '.length);
      expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
      const restoreLine = rename.stdout.split('\n').find((l) => l.includes('Restore if needed'))!;
      const command = restoreLine.slice(restoreLine.indexOf('sqlite3 '));
      const run = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const after = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
      expect(after.stdout).toContain('odd-old');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: the rename-project backup holds writes still in the WAL file of an open connection', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-wal-'));
    const { DatabaseSync } = await import('node:sqlite');
    let held: InstanceType<typeof DatabaseSync> | undefined;
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'seed-wal', '--type', 'note', '--obs', 'x', '--tags', 'project:old-wal',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      // Another live process (a hook, the MCP server) keeps a connection
      // open, so its latest write sits in the -wal file, not the main file.
      const dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
      held = new DatabaseSync(dbPath);
      held.exec('PRAGMA wal_autocheckpoint = 0');
      held.prepare("INSERT INTO entities (name, type) VALUES ('only-in-wal', 'note')").run();
      const rename = spawnSync(process.execPath, cliArgs(
        'kg', 'rename-project', '--from', 'old-wal', '--to', 'new-wal', '--apply', '--json',
      ), { encoding: 'utf8', env });
      expect(rename.status, rename.stderr).toBe(0);
      const { backupPath } = JSON.parse(rename.stdout) as { backupPath: string };
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try {
        expect(backup.prepare("SELECT count(*) AS n FROM entities WHERE name = 'only-in-wal'").get()).toEqual({ n: 1 });
      } finally {
        backup.close();
      }
    } finally {
      held?.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('kg rename-project refuses a filesystem path as --to, before computing any preview', () => {
    // `--to` names the destination scope that both entities and durable
    // agent-message rows get rewritten into — the same identity `send`
    // refuses as a path-shaped recipient. `--from` is deliberately exempt:
    // it must match an existing, possibly-broken row exactly, including one
    // that is itself path-shaped (the thing an owner is trying to fix).
    //
    // No `--apply` and no seeded data on purpose: `--from` names a project
    // that carries nothing, so if `--to` validation were ever removed, the
    // handler would fall through to `renameProjectTag`'s dry-run preview,
    // find zero affected rows, print "Nothing to do", and exit 0 — a
    // vacuous pass that never reaches the code this test is meant to guard.
    // Validation runs before the preview is even computed, so this must
    // fail regardless of --apply or of what --from resolves to.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-'));
    try {
      const rename = spawnSync(process.execPath, cliArgs(
        'kg', 'rename-project', '--from', 'old-name', '--to', '/Users/x/Projects/repo',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(rename.status, rename.stdout).not.toBe(0);
      expect(rename.stderr).toContain('--to:');
      expect(rename.stderr).toContain('must be a stable identifier, not a filesystem path');
      expect(rename.stdout).not.toContain('Dry-run');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('creates reusable owner-private managed host config without a fabricated session identity', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-'));
    try {
      const setup = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex', '--project', 'test', '--principal', 'reviewer',
        '--workspace', home, '--model', 'gpt-5.6-luna',
        '--work-summary', 'review agent directory', '--json',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(setup.status, setup.stderr).toBe(0);
      const result = JSON.parse(setup.stdout) as {
        config_path: string;
        session_identity: string;
        ordinary_sessions: string;
        registration_command: string | null;
        launch_command: string;
      };
      expect(result).toMatchObject({
        session_identity: 'generated-per-process',
        ordinary_sessions: 'presence-only/inbound-unavailable',
        registration_command: null,
        launch_command: expect.stringContaining('memesh-host-codex'),
      });
      const config = JSON.parse(readOwnerPrivateRegularFile(result.config_path)) as Record<string, unknown>;
      expect(config).toMatchObject({
        project: 'test', principal_id: 'reviewer', workspace: home,
        work_summary: 'review agent directory',
      });
      // --model is accepted for older scripts but never written.
      expect(config).not.toHaveProperty('model');
      expect(setup.stderr).toContain('--model is ignored');
      expect(config).not.toHaveProperty('session_instance_id');
      expect(config).not.toHaveProperty('thread_id');

      const repeat = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex', '--project', 'test', '--principal', 'replacement',
        '--workspace', home,
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(repeat.status).not.toBe(0);
      expect(repeat.stderr).toContain('was not overwritten');
      expect(JSON.parse(readOwnerPrivateRegularFile(result.config_path))).toMatchObject({ principal_id: 'reviewer' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects an overlong agent discovery declaration before writing config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-metadata-'));
    try {
      const setup = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex', '--project', 'test', '--principal', 'reviewer',
        '--workspace', home, '--work-summary', 'x'.repeat(201), '--json',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(setup.status).not.toBe(0);
      expect(setup.stderr).toContain('--work-summary must be a non-empty string of at most 200 characters');
      expect(fs.existsSync(path.join(home, '.memesh', 'hosts', 'codex.json'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // eg prove reported src/transports/cli/cli.ts's owner-private-directory
  // throw as UNPROTECTED: removing it broke nothing any test checked. The
  // guard is a security boundary — a symlinked or group-readable hosts/
  // directory would let the managed config (which names the router socket
  // and token file) be written somewhere another principal controls. Three
  // ways the directory can be wrong, each must refuse and write nothing.
  describe.skipIf(process.platform === 'win32')('refuses to write managed host config into a directory that is not owner-private', () => {
    function attempt(home: string) {
      return spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex', '--project', 'test', '--principal', 'reviewer', '--workspace', home, '--json',
      ), { encoding: 'utf8', env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' } });
    }
    function hostsDirOf(home: string) { return path.join(home, '.memesh', 'hosts'); }

    it('when hosts/ is a symlink to elsewhere', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-hosts-symlink-'));
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-elsewhere-'));
      try {
        fs.mkdirSync(path.join(home, '.memesh'), { recursive: true, mode: 0o700 });
        fs.symlinkSync(elsewhere, hostsDirOf(home));
        const r = attempt(home);
        expect(r.status, r.stdout).not.toBe(0);
        expect(r.stderr).toContain('owner-private');
        expect(fs.readdirSync(elsewhere), 'nothing may be written through the symlink').toEqual([]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('when hosts/ is a regular file, not a directory', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-hosts-file-'));
      try {
        fs.mkdirSync(path.join(home, '.memesh'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(hostsDirOf(home), 'not a directory');
        const r = attempt(home);
        expect(r.status, r.stdout).not.toBe(0);
        expect(fs.readFileSync(hostsDirOf(home), 'utf8'), 'the file is untouched').toBe('not a directory');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('when hosts/ is readable by group or others', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-hosts-mode-'));
      try {
        fs.mkdirSync(hostsDirOf(home), { recursive: true, mode: 0o755 });
        fs.chmodSync(hostsDirOf(home), 0o755); // mkdir honours umask; force it
        const r = attempt(home);
        expect(r.status, r.stdout).not.toBe(0);
        expect(r.stderr).toContain('owner-private');
        expect(fs.readdirSync(hostsDirOf(home)), 'no config written into a shared directory').toEqual([]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it.skipIf(process.platform === 'win32')('creates an optional owner-private stable-principal override for one Codex workspace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-'));
    try {
      const setup = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex-session', '--project', 'test', '--principal', 'reviewer',
        '--workspace', home, '--json',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(setup.status, setup.stderr).toBe(0);
      const result = JSON.parse(setup.stdout) as Record<string, unknown>;
      expect(result).toMatchObject({
        mode: 'ordinary-session-native-queue',
        session_identity: 'codex-thread-id-at-session-start',
        ordinary_sessions: 'automatic-thread-scoped-with-workspace-override',
        launch_command: null,
        next_command: 'Restart Codex in the configured workspace to apply the identity override',
      });
      const configPath = String(result.config_path);
      expect(configPath).toMatch(/hosts\/codex-session\.json$/);
      expect(JSON.parse(readOwnerPrivateRegularFile(configPath))).toMatchObject({
        project: 'test', principal_id: 'reviewer', workspace: fs.realpathSync(home),
      });
      const tokenPath = path.join(home, '.memesh', 'agent-router.token');
      expect(fs.readFileSync(tokenPath, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.statSync(tokenPath).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('prints both Claude one-time registration and the required development-channel launch', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-'));
    try {
      const setup = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'claude', '--project', 'project-a', '--principal', 'claude-a', '--json',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(setup.status, setup.stderr).toBe(0);
      const result = JSON.parse(setup.stdout) as {
        registration_command: string;
        launch_command: string;
        next_command: string;
      };
      expect(result.registration_command).toContain('claude mcp add --transport stdio --scope user memesh-channel');
      expect(result.next_command).toBe(result.registration_command);
      expect(result.launch_command).toBe('claude --dangerously-load-development-channels server:memesh-channel');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // The launch and registration commands embed the config path (#520): a
  // data folder whose name holds `$(...)` must not run it when pasted.
  it.skipIf(process.platform === 'win32')('the printed launch and registration commands run nothing the config path holds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-quote-'));
    try {
      const home = path.join(root, "h$(touch m1)`touch m2`;touch m3;it's");
      const cwd = path.join(root, 'cwd');
      fs.mkdirSync(home);
      fs.mkdirSync(cwd);
      for (const host of ['codex', 'claude']) {
        const setup = spawnSync(process.execPath, cliArgs(
          'agent', 'setup', host, '--project', 'test', '--principal', `p-${host}`, ...(host === 'codex' ? ['--workspace', home] : []), '--json',
        ), { encoding: 'utf8', env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' } });
        expect(setup.status, setup.stderr).toBe(0);
        const result = JSON.parse(setup.stdout) as { registration_command: string | null; launch_command: string | null };
        for (const command of [result.registration_command, result.launch_command]) {
          if (!command) continue;
          spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
          for (const marker of ['m1', 'm2', 'm3']) expect(fs.existsSync(path.join(cwd, marker)), `${marker} created by: ${command}`).toBe(false);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A declared model was a guess: the host picks the model per session (and
  // `/model` changes it mid-session), and no host tells MeMesh which one runs.
  // An older script may still pass --model, so it is accepted, said to be
  // ignored, and never written.
  it.skipIf(process.platform === 'win32')('accepts --model, says it is ignored, and writes no model', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-model-'));
    try {
      const setup = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'claude', '--principal', 'claude-a', '--model', 'claude-fable-5-1', '--json',
      ), { encoding: 'utf8', env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' } });
      expect(setup.status, setup.stderr).toBe(0);
      expect(setup.stderr).toContain('--model is ignored');
      const config = JSON.parse(readOwnerPrivateRegularFile(path.join(home, '.memesh', 'hosts', 'claude.json')));
      expect(config).not.toHaveProperty('model');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('rejects managed host setup before creating host files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-windows-'));
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex', '--project', 'test', '--principal', 'reviewer',
        '--workspace', home, '--json',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/secure local host runtime is not supported on Windows/i);
      expect(fs.existsSync(path.join(home, '.memesh'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});
