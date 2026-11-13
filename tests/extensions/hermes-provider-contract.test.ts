/**
 * Contract test for extensions/hermes-memesh (the Hermes Agent MemoryProvider).
 *
 * Nothing in this repository used to run that plugin, and Pitfall 1 in
 * docs/platforms/hermes-agent.md is what that cost: the recall envelope
 * changed under it and nobody noticed. This drives the real provider code in
 * a real Python process against a real `memesh serve` and a real `memesh`
 * CLI. Only two modules are stood in for, both at the edge the provider
 * cannot run without: `agent.memory_provider` (Hermes's base class) and
 * `httpx` (a urllib-backed stub that still sends real HTTP) — see
 * tests/fixtures/hermes/stubs.
 *
 * Skipped, visibly, where it cannot run: no Python 3 on PATH, or Windows (the
 * `memesh` shim on PATH is a POSIX shell script).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.join(__dirname, '..', '..');
const CLI_PATH = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');
const EXT_INIT = path.join(repoRoot, 'extensions', 'hermes-memesh', '__init__.py');
const FIXTURES = path.join(repoRoot, 'tests', 'fixtures', 'hermes');

const python = ['python3', 'python'].find((bin) => {
  const r = spawnSync(bin, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']);
  return r.status === 0;
});
const skipReason = process.platform === 'win32'
  ? 'POSIX-only: the memesh shim is a shell script'
  : !python ? 'no Python 3 on PATH' : null;
if (skipReason) console.warn(`[hermes-provider-contract] skipped: ${skipReason}`);

describe.skipIf(skipReason !== null)('Hermes MemeshProvider against a real memesh serve', () => {
  let home: string;
  let server: ChildProcess;
  let result: Record<string, any>;
  let dbPath: string;
  let queue: Record<string, any>;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-contract-'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.MEMESH_DB_PATH;
    delete env.MEMESH_DIR;

    server = spawn('node', [CLI_PATH, 'serve', '--port', '0'], { env });
    const baseUrl = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`serve did not start: ${out}`)), 20_000);
      server.stdout!.on('data', (d) => {
        out += String(d);
        const m = /running at (http:\/\/[^\s]+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
    });

    // `memesh` on PATH is this checkout's CLI, the one the provider shells out to.
    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'memesh'), `#!/bin/sh\nexec node "${CLI_PATH}" "$@"\n`, { mode: 0o755 });
    const hermesHome = path.join(home, 'hermes');
    fs.mkdirSync(hermesHome);
    fs.writeFileSync(path.join(hermesHome, 'memesh.json'), JSON.stringify({ base_url: baseUrl }));

    const run = spawnSync(python!, [
      path.join(FIXTURES, 'drive_provider.py'), EXT_INIT, hermesHome, path.join(FIXTURES, 'session-messages.json'),
    ], {
      env: {
        ...env,
        PATH: `${binDir}${path.delimiter}${env.PATH ?? ''}`,
        PYTHONPATH: path.join(FIXTURES, 'stubs'),
        PYTHONDONTWRITEBYTECODE: '1',
      },
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (run.status !== 0) throw new Error(`driver exited ${run.status}:\n${run.stderr}\n${run.stdout}`);
    result = JSON.parse(run.stdout.trim().split('\n').pop()!);

    const fake = path.join(home, 'fake-memesh');
    fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "[1]"\n', { mode: 0o755 });
    const q = spawnSync(python!, [path.join(FIXTURES, 'drive_queue.py'), EXT_INIT, hermesHome, fake], {
      env: { ...env, PYTHONPATH: path.join(FIXTURES, 'stubs'), PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (q.status !== 0) throw new Error(`queue driver exited ${q.status}:\n${q.stderr}\n${q.stdout}`);
    queue = JSON.parse(q.stdout.trim().split('\n').pop()!);
    dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
  }, 180_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.on('exit', resolve));
    }
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('sync_turn never blocks the host on a slow capture; a full queue is logged, not waited on (F4)', () => {
    expect(queue.sync_turn_20_calls_secs).toBeLessThan(1);
    expect(queue.queue_full_warnings).toBeGreaterThan(0);
  });

  it('turns still queued at session end are drained; any left after the bounded wait are reported (re-review P1)', () => {
    expect(queue.drained_captures).toBe(3);
    expect(queue.drained_unfinished).toBe(0);
    // One shared deadline for session end + shutdown (round 3 P2-2), one
    // warning, and queued vs still-running reported apart (P3-3).
    expect(queue.end_plus_shutdown_secs).toBeLessThan(0.9);
    expect(queue.lost_warnings).toEqual([
      'MeMesh: 2 queued turn(s) not captured before shutdown; 1 capture(s) still running and may finish',
    ]);
  });

  it('a late turn between session end and shutdown does not extend the wait; a cross-thread turn does not break the drain (round 4)', () => {
    expect(queue.late_total_drain_secs).toBeLessThan(0.9);
    expect(queue.cross_thread_drain_errors).toEqual([]);
    expect(queue.deadline_after_switch).toBeNull();
  });

  it('shutdown() before initialize() does not raise (round 3 P2-1)', () => {
    expect(queue.shutdown_before_initialize).toBe('ok');
  });

  it('never reuses a prefetch from another session or before a reset', () => {
    expect(queue.after_reset_prefetch).toBe('new:before');
    expect(queue.explicit_session_prefetch).toBe('new:explicit-new');
  });

  it('skips unavailable, failed, malformed, oversized or timed-out automatic recall', () => {
    expect(queue.recall_failures).toEqual(Array(7).fill(''));
  });

  it('non-primary skips and non-object CLI output leave a log line (F5)', () => {
    expect(queue.non_primary_debug).toBe(1);
    expect(queue.non_dict_result).toBeNull();
    expect(queue.non_dict_warnings).toBe(1);
  });

  function query<T>(sql: string, ...params: unknown[]): T[] {
    // A separate read-only process, so this test never holds a handle on the
    // database the server and the CLI are writing.
    const r = spawnSync('node', ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      console.log(JSON.stringify(db.prepare(process.argv[2]).all(...JSON.parse(process.argv[3]))));
    `, dbPath, sql, JSON.stringify(params)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout) as T[];
  }

  it('is available once memesh is on PATH, and the system prompt block tells the model to save by default', () => {
    expect(result.available).toBe(true);
    expect(result.system_prompt_block).toContain('MeMesh auto-recalls relevant memory each turn');
    expect(result.system_prompt_block).toContain('Saving is on by default');
    expect(result.system_prompt_block).toContain('remove a specific stored memory');
    expect(result.system_prompt_block).not.toMatch(/only exception|not to save|current_turn/);
  });

  it('explicit tools round-trip the HTTP envelope (remember, recall, forget)', () => {
    expect(result.remember.success).toBe(true);
    expect(result.recall_tool.success).toBe(true);
    expect(Array.isArray(result.recall_tool.data.entities)).toBe(true);
    expect(result.recall_tool.data.entities.map((e: { name: string }) => e.name)).toContain('contract-fact');
    expect(result.forget.success).toBe(true);
  });

  it('a decision without a reason is stored; a later call with one adds the reason', () => {
    expect(result.remember_bare.success).toBe(true);
    expect(result.remember_decision.success).toBe(true);
    expect(query<{ content: string }>(
      "SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'contract-choice' ORDER BY o.id",
    ).map((r) => r.content)).toEqual(['Chose the plain option', 'Why: it is the least moving parts; revisit if it stops scaling']);
  });

  it('prefetch shares the bounded content contract and excludes its own session', () => {
    expect(result.own_prefetch).toBe('');
    expect(result.prefetch).toContain('MeMesh reference memory.');
    expect(result.prefetch).toContain('BullMQ');
    expect(result.prefetch).toMatch(/\[mem:\d+\]/);
    expect(Buffer.byteLength(result.prefetch)).toBeLessThanOrEqual(4096);
    expect(result.repeat_prefetch).toBe('');
    expect(result.other_reader_prefetch).toBe(result.prefetch);
  });

  it('sync_turn stores both sides of every turn, in full, whatever they say', () => {
    const rows = query<{ name: string; metadata: string; title: string }>(
      "SELECT name, metadata, title FROM entities WHERE type = 'conversation' ORDER BY name",
    );
    // Two turns, two sides each: ordinary chat is kept like a decision.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.name.replace(/-[0-9a-f-]{36}-/, '-')).sort()).toEqual([
      'hermes-turn-contract-session-assistant', 'hermes-turn-contract-session-assistant',
      'hermes-turn-contract-session-user', 'hermes-turn-contract-session-user',
    ]);
    for (const r of rows) expect(JSON.parse(r.metadata).provenance.source_host).toBe('hermes');
    const said = query<{ content: string }>(
      "SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.type = 'conversation' ORDER BY o.content",
    ).map((r) => r.content);
    expect(said).toEqual(['Hello! How can I help?', 'We decided to use BullMQ for the job queue.', 'Which queue should we use?', 'hi']);
    expect(query<{ tag: string }>(
      "SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name LIKE '%-user' AND t.tag LIKE 'role:%'",
    ).map((r) => r.tag)).toEqual(['role:user', 'role:user']);
  });

  it('compression and session end store nothing and add nothing to the compressed context', () => {
    expect(result.pre_compress).toBe('');
    expect(query("SELECT name FROM entities WHERE type IN ('session-insight', 'conversation-archive', 'conversation-checkpoint')")).toEqual([]);
  });
});
