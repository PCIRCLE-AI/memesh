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
import { CAPTURE_HOOKS, FAIL_ELIGIBLE_HOOKS, parseHookOutcomeLine, renderableErrorReason, renderableSkipReason } from '../../src/core/capture-liveness.js';

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

  it('memesh_private_session stops capture for that session only, including turns already queued', () => {
    expect(queue.private_tool_listed).toBe(true);
    expect(queue.private_reply.success).toBe(true);
    expect(queue.private_captures).toBe(0);
    expect(queue.private_compress_text).not.toMatch(/summary here can stay concise/);
    expect(queue.private_compress_text).toMatch(/private/);
    expect(queue.control_captures).toBeGreaterThan(0);
    expect(queue.queued_after_private).toEqual(['a0']);
  });

  it('after a restart, a turn whose history holds the call is not captured, and neither are the turns after it', () => {
    expect(queue.restart_turns.with_call).toEqual([]);
    expect(queue.restart_turns.without_call).toEqual(['capture-turn', 'capture-turn']);
  });

  it('session-end capture reads the history for the call, with or without the memesh_ prefix', () => {
    expect(queue.session_end_captures.prefixed).toEqual([]);
    expect(queue.session_end_captures.bare).toEqual([]);
    expect(queue.session_end_captures.plain).toEqual(['capture-session']);
  });

  describe('the private mark survives the new provider instance Hermes starts at /compress, /resume and /branch', () => {
    it('after /compress: a new instance with the same id and a history with no tool call saves nothing', () => {
      expect(queue.marker.compress_new_instance_captures).toEqual([]);
      expect(queue.marker.init_knows_private).toBe(true); // initialize reads the marker
      expect(queue.marker.late_marker_captures).toEqual([]); // and a marker another instance writes later is honoured
      expect(queue.marker.file_content).toBe('qa-session'); // only the id, no content
      expect(queue.marker.file_mode).toBe(0o600);
    });

    it('after /branch then /compress: the branch marks itself from its history, and stays private', () => {
      expect(queue.marker.branch_then_compress_captures).toEqual([]);
    });

    it('/resume of an unrelated old session saves as usual; /resume of one that was private stays private', () => {
      expect(queue.marker.resume_unrelated_captures).toBeGreaterThan(0);
      expect(queue.marker.resume_private_captures).toBe(0);
    });

    it('a compression child writes its own marker; a resume target is not given one', () => {
      expect(queue.marker.compressed_child_captures).toBe(0);
      expect(queue.marker.resumed_target_captures).toBeGreaterThan(0);
    });

    const parsed = (lines: string[]) => lines.map((line) => parseHookOutcomeLine(line));
    const root = process.getuid?.() === 0;

    it.skipIf(root)('a marker that cannot be written (its folder is read-only) is said so in the reply and recorded, and saving still stops in this process', () => {
      expect(queue.marker.write_failure_reply).toMatchObject({ success: true, marker_written: false });
      expect(queue.marker.write_failure_reply.message).toMatch(/saving may start again/);
      expect(queue.marker.write_failure_captures).toEqual([]);
      const records = parsed(queue.marker.write_failure_records);
      expect(records.filter((r) => r?.outcome === 'error')).toEqual([expect.objectContaining({ hook: 'hermes-private-session', host: 'hermes', outcome: 'error', reason: 'the private-session marker could not be written' })]);
      // Every capture it stopped says so (a skip with the fixed reason), so no exit is silent.
      expect(records.filter((r) => r?.outcome === 'skipped').map((r) => r?.reason)).toEqual(expect.arrayContaining(['private_session']));
    });

    it.skipIf(root)('a marker that cannot be read counts as private and is recorded, for this scenario alone', () => {
      expect(queue.marker.read_failure_captures).toEqual([]);
      const records = parsed(queue.marker.read_failure_records);
      expect(records.length).toBeGreaterThan(0);
      expect(new Set(records.map((r) => r?.reason))).toEqual(new Set(['the private-session marker could not be read']));
    });

    it('records are in the shape doctor reads: its own hook name, the hermes host, an error, a hex run id', () => {
      const lines: string[] = queue.marker.records;
      expect(lines.length).toBeGreaterThan(0);
      for (const record of parsed(lines)) {
        expect(record).not.toBeNull();
        expect(record).toMatchObject({ hook: 'hermes-private-session', host: 'hermes' });
        expect(['error', 'skipped']).toContain(record?.outcome);
        expect(record?.run).toMatch(/^[0-9a-f]{8,64}$/);
        // Doctor quotes a reason only from its closed lists: a sentence the plugin writes that is not on them shows
        // as "an unlabelled error" or "unrecognised reason" (Q6_17 F7). The plugin's sentences are bound to doctor's here.
        if (record?.outcome === 'error') expect(renderableErrorReason(record.reason), record.reason).toBe(record.reason);
        else expect(renderableSkipReason(record?.reason), record?.reason).toBe(record?.reason);
      }
      expect(parsed(lines).some((r) => r?.outcome === 'error')).toBe(true);
      expect(CAPTURE_HOOKS as readonly string[]).toContain('hermes-private-session');
      expect(FAIL_ELIGIBLE_HOOKS as readonly string[]).not.toContain('hermes-private-session');
    });

    it('a turn waiting in the queue is skipped when another instance marks the session private on disk (the worker reads the disk), and the skip is recorded', () => {
      expect(queue.marker.queued_turn_after_disk_mark).toEqual(['turn-one']);
      expect(parsed(queue.marker.queued_turn_after_disk_mark_records).map((r) => `${r?.outcome}:${r?.reason}`)).toEqual(['skipped:not a private session', 'skipped:private_session']);
    });

    it.skipIf(root)('a turn waiting in the queue when the marker folder becomes unreadable is not saved, and the worker records why', () => {
      expect(queue.marker.queued_turn_unreadable_captures).toEqual(['turn-one']);
      expect(parsed(queue.marker.queued_turn_unreadable_records).map((r) => `${r?.outcome}:${r?.reason}`)).toEqual(['error:the private-session marker could not be read']);
    });

    it('one instance through seven compressions, a cycle and a session that is its own parent: every ordinary session saves, and no error is recorded', () => {
      expect(queue.marker.chain_captures).toEqual(['ch-1', 'ch-2', 'ch-3', 'ch-4', 'ch-5', 'ch-6', 'ch-7', 'ch-6', 'ch-7']);
      expect(queue.marker.chain_errors).toEqual([]);
    });

    it.skipIf(root)('a parent whose marker could not be read at the switch still makes its compression private once it can be read, and the child gets its own marker', () => {
      expect(queue.marker.deferred_inherit_captures).toEqual([]);
      expect(queue.marker.deferred_inherit_child_marker).toBe(true);
    });

    it.skipIf(root)('the same in a new instance after a restart: nothing saved and an error while the parent cannot be read, private once it can; an ordinary parent saves (G08 F3)', () => {
      expect(queue.marker.new_instance_parent_unreadable_captures).toEqual([]);
      expect(parsed(queue.marker.new_instance_parent_unreadable_records).map((r) => `${r?.outcome}:${r?.reason}`)).toEqual(['error:the private-session marker could not be read']);
      expect(queue.marker.new_instance_parent_readable_captures).toEqual([]);
      expect(queue.marker.new_instance_child_marker).toBe(true);
      expect(queue.marker.new_instance_plain_child_captures).toEqual(['capture-turn']);
    });

    it.skipIf(root)('a folder of recorded parents that cannot be read saves nothing and records why', () => {
      expect(queue.marker.parents_unreadable_captures).toEqual([]);
      expect(parsed(queue.marker.parents_unreadable_records).map((r) => `${r?.outcome}:${r?.reason}`)).toEqual(['error:the private-session marker could not be read']);
    });

    it('when `memesh hermes capture-turn` or `capture-session` could not check the session, the provider records the error it names', () => {
      const FOLDER = 'error:the private-sessions folder beside the database cannot be read, so every session is treated as private and nothing is saved until it can be';
      expect(parsed(queue.marker.cli_unchecked_records).map((r) => `${r?.outcome}:${r?.reason}`)).toEqual(['skipped:not a private session', FOLDER, FOLDER]);
    });

    it('a parents file is replaced whole or not at all: a write that fails half way leaves the previous version and no stray file', () => {
      expect(queue.marker.torn_write_parents).toEqual({ 'tw-parent': false });
      expect(queue.marker.torn_write_files).toEqual(['tw-child']);
      expect(queue.marker.torn_write_records).toEqual(['error:the private-session marker could not be written']);
    });

    it('a history that shows the call writes the marker, so the next instance of the session saves nothing', () => {
      expect(queue.marker.history_derived_then_new_instance).toEqual([]);
    });

    it('a parent that is private only on disk makes its branch private, and the branch writes its own marker', () => {
      expect(queue.marker.parent_only_on_disk_child_captures).toEqual([]);
    });

    it('a dangling symlink is a marker (private); a marker that is a symlink is never written through', () => {
      expect(queue.marker.dangling_marker_captures).toEqual([]);
      expect(queue.marker.symlink_write_reply).toMatchObject({ marker_written: false });
      expect(queue.marker.symlink_written_through).toBe(false);
    });

    it('with no Hermes home nothing is saved, and every capture that stops records the error (it is decided again each time, never remembered as private)', () => {
      expect(queue.marker.no_home_captures).toEqual([]);
      const records = parsed(queue.marker.no_home_records);
      expect(records.length).toBeGreaterThan(1);
      expect(new Set(records.map((r) => `${r?.outcome}:${r?.reason}`))).toEqual(new Set(['error:the private-session marker could not be kept or read: Hermes gave no home folder']));
    });

    it('a switch with no reason from a private session saves nothing and says why at every capture, the same after a restart; no private marker is written for it (G19 F2)', () => {
      const NO_REASON = 'Hermes did not say why the session changed, so the new session is treated as private';
      expect(queue.marker.no_reason_switch_captures).toEqual([]);
      const records = parsed(queue.marker.no_reason_switch_records);
      // The switch itself, the turn and the session end: each stops and records the same error.
      expect(records.filter((r) => r?.outcome === 'error').map((r) => r?.reason)).toEqual(Array(3).fill(NO_REASON));
      expect(queue.marker.no_reason_switch_marker, 'not made private for good on a guess').toBe(false);
      expect(queue.marker.no_reason_switch_next_instance_captures).toEqual([]);
      expect(parsed(queue.marker.no_reason_switch_next_instance_records).map((r) => `${r?.outcome}:${r?.reason}`)).toEqual(Array(2).fill(`error:${NO_REASON}`));
    });

    it('a switch with no reason from an ordinary session saves as usual, before and after a restart (G19 F1)', () => {
      expect(queue.marker.no_reason_ordinary_captures).toEqual(['capture-turn', 'capture-turn']);
    });

    describe('the S3 redesign', () => {
      const outcomesOf = (lines: string[]) => parsed(lines).map((r) => `${r?.outcome}:${r?.reason}`);
      it('an empty session id saves nothing and records the error at every capture that stops (Q6_12 F2)', () => {
        expect(queue.marker.empty_id_captures).toEqual([]);
        const records = outcomesOf(queue.marker.empty_id_records);
        expect(records.length).toBeGreaterThan(0);
        expect(new Set(records)).toEqual(new Set(['error:the host gave no session id, so whether the session is private cannot be told and nothing is saved']));
      });
      it.skipIf(root)('a marker folder unreadable at one turn and readable at the next: the second turn is saved (unchecked is not remembered, H10)', () => {
        expect(queue.marker.unchecked_then_ok_captures).toEqual(['capture-turn']);
      });
      it('a compression switch that says its reason records no guess (H8)', () => {
        expect(outcomesOf(queue.marker.compress_reason_records).filter((r) => r.includes('did not say why'))).toEqual([]);
      });
      it('a healthy instance records once that the session was checked and is not private, so an old error clears in doctor', () => {
        expect(outcomesOf(queue.marker.healthy_records)).toEqual(['skipped:not a private session']);
      });
      it('one instance that checks two ordinary sessions records each of them once (Q6_13 Nit 7)', () => {
        expect(outcomesOf(queue.marker.healthy_two_sessions_records)).toEqual(['skipped:not a private session', 'skipped:not a private session']);
      });
      it('every capture a private session stops leaves a skip record: each turn, the compression and the session end (Q6_13 F2)', () => {
        expect(queue.marker.private_skip_captures).toEqual([]);
        expect(outcomesOf(queue.marker.private_skip_records)).toEqual(Array(4).fill('skipped:private_session'));
      });
      it('a marker is never removed for its age: a session marked 31 days ago and resumed without the call in its history saves nothing', () => {
        expect(queue.marker.old_marker_captures).toEqual([]);
        expect(queue.marker.old_marker_left).toEqual(['old-session']);
      });
      it('a capture that cannot be checked tells the compression summary that nothing is saved, without calling the session private (G08 Nit)', () => {
        expect(queue.marker.unchecked_compress_text).toBe('MeMesh cannot tell whether this session is private, so it saves nothing from it for now.');
        expect(queue.private_compress_text).toBe('This session is private: MeMesh saves nothing from it.');
      });
      it('reads an empty MEMESH_DIR as no value, as getMemeshDirFromDbPath does (shared table, Q6_21 F8)', () => {
        const rows = queue.marker.record_dir_cases as Array<{ name: string; home: boolean }>;
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(r.home, r.name).toBe(true);
      });
      it('records resume_legacy\'s guess in the test\'s own folder, not under the real home (Q6_12 Nit 5)', () => {
        // Counted in the test's folder during that scenario alone: a later scenario writes the same sentence (G17 #1).
        expect(parsed(queue.private_after_switch_records.resume_legacy).map((r) => r?.reason)).toContain('Hermes did not say why the session changed, so the new session is treated as private');
      });
      it('decides every case of the shared table the way the TypeScript decider does', () => {
        for (const c of queue.marker.case_table as Array<{ name: string; state: string; expect: string }>) expect(c.state, c.name).toBe(c.expect);
      });
    });

    it('a relative MEMESH_DB_PATH still receives the record', () => {
      expect(queue.marker.relative_db_record_written).toBe(true);
    });

    it('a session id that is not a plain token becomes a hashed file name inside the marker folder and never leaves it', () => {
      const files: string[] = queue.marker.unsafe_id_files;
      expect(files).toContain('ok-id_1.2');
      expect(files.filter((name) => /^[0-9a-f]{64}$/.test(name))).toHaveLength(5); // ../x, a/b, .hidden, .. and with:colon
      expect(queue.marker.unsafe_id_escaped).toEqual([]);
    });
  });

  it('a branched or compressed session inherits the private flag in memory, a /resume of an old session and a reset do not', () => {
    expect(queue.private_after_switch.resume_legacy).toBe(0);
    expect(queue.private_after_switch.branch).toBe(0);
    expect(queue.private_after_switch.compression).toBe(0);
    expect(queue.private_after_switch.reset).toBeGreaterThan(0);
    // /resume of an old session that was never private is not made private by the one just left.
    expect(queue.private_after_switch.resume_unrelated).toBeGreaterThan(0);
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

  it('non-primary skips and non-object CLI output leave a log line (F5)', () => {
    expect(queue.non_primary_debug).toBe(2);
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
  });

  it('explicit tools round-trip the HTTP envelope (remember, recall, forget)', () => {
    expect(result.remember.success).toBe(true);
    expect(result.recall_tool.success).toBe(true);
    expect(Array.isArray(result.recall_tool.data.entities)).toBe(true);
    expect(result.recall_tool.data.entities.map((e: { name: string }) => e.name)).toContain('contract-fact');
    expect(result.forget.success).toBe(true);
  });

  it('a refused write comes back as the server\'s sentence, not a bare status line; with a reason it is stored', () => {
    expect(result.remember_refused.success).toBe(false);
    expect(result.remember_refused.error).toMatch(/needs `why`.*reason for it and what would make it stop holding/);
    expect(result.remember_refused.error).not.toMatch(/^HTTP \d+/);
    expect(result.remember_decision.success).toBe(true);
    expect(query<{ content: string }>(
      "SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'contract-choice' ORDER BY o.id",
    ).map((r) => r.content)).toEqual(['Chose the plain option', 'Why: it is the least moving parts; revisit if it stops scaling']);
  });

  it('prefetch parses the recall envelope into an injected block', () => {
    expect(result.prefetch).toContain('[MeMesh recall]');
    expect(result.prefetch).toMatch(/hermes-turn-contract-session-/);
  });

  it('sync_turn stores nothing for ordinary chat and one row for a decision', () => {
    const rows = query<{ name: string; metadata: string }>(
      "SELECT name, metadata FROM entities WHERE type = 'conversation'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toMatch(/^hermes-turn-contract-session-[0-9a-f]{12}$/);
    expect(JSON.parse(rows[0].metadata).provenance.source_host).toBe('hermes');
  });

  it('a second capture of the same messages adds no observations (F7)', () => {
    expect(result.observations_after_first).toBeGreaterThan(0);
    expect(result.observations_after_second).toBe(result.observations_after_first);
  });

  it('on_session_end produces the three session-insight entities, not a transcript', () => {
    expect(result.session_end.outcome).toBe('wrote');
    const rows = query<{ name: string; metadata: string }>(
      "SELECT name, metadata FROM entities WHERE type = 'session-insight' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual([
      'session-contract-session-files',
      'session-contract-session-fixes',
      'session-contract-session-summary',
    ]);
    for (const r of rows) expect(JSON.parse(r.metadata).provenance.source_host).toBe('hermes');
    // The raw archive types are gone.
    expect(query("SELECT name FROM entities WHERE type IN ('conversation-archive', 'conversation-checkpoint')")).toEqual([]);
  });
});
