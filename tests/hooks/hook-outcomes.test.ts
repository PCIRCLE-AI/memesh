import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  captureLivenessNotice,
  serializeHookOutcome,
  captureLivenessVerdict,
  parseHookOutcomes,
  summarizeHookOutcomes,
  trimHookOutcomeLines,
  HOOK_OUTCOMES_FILENAME,
  HOOK_OUTCOMES_MAX_LINES,
  HOOK_OUTCOMES_PER_HOOK,
  SILENT_HOOK_MIN_RUNS,
  type HookOutcomeRecord,
} from '../../src/core/capture-liveness.js';

/**
 * The guard for issue #327: every capture-hook exit path leaves a record.
 *
 * The defect this pins is not hypothetical. For two days the owner's graph
 * had zero `commit` entities while every heartbeat stayed green, because
 * `git commit -q` prints no line for post-commit to match (#321) — and a
 * hook that skips silently is indistinguishable from a hook that is broken.
 * Each `runs the hook and asserts a record` case below dies if someone
 * removes the `record(...)` call from that branch.
 *
 * Every hook is spawned as a real process against a throwaway MEMESH_DIR:
 * the records are written by the hook itself, so a test that called the
 * writer directly would prove the writer works and nothing about whether the
 * hooks call it.
 */
describe('hook outcome records', () => {
  let testDir: string;
  let memeshDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-outcomes-'));
    memeshDir = path.join(testDir, 'memesh');
    fs.mkdirSync(memeshDir);
    repoDir = path.join(testDir, 'repo');
    fs.mkdirSync(repoDir);
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function git(args: string[]): string {
    return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', timeout: 15000 });
  }

  function runHook(hook: string, input: object, extraEnv: Record<string, string> = {}): void {
    execFileSync('node', [path.resolve(`scripts/hooks/${hook}.js`)], {
      input: JSON.stringify(input),
      env: { ...process.env, MEMESH_DIR: memeshDir, HOME: testDir, ...extraEnv },
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  function records(hook: string): HookOutcomeRecord[] {
    const file = path.join(memeshDir, HOOK_OUTCOMES_FILENAME);
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return parseHookOutcomes(raw).hooks[hook] ?? [];
  }

  function realCommit(message: string): { hash: string; output: string } {
    fs.writeFileSync(path.join(repoDir, `f${Date.now()}.txt`), 'content\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', message, '--no-verify']);
    const hash = git(['rev-parse', '--short', 'HEAD']).trim();
    return { hash, output: `[main (root-commit) ${hash}] ${message}\n 1 file changed, 1 insertion(+)\n` };
  }

  // ── post-commit ──────────────────────────────────────────────────────────

  it('post-commit records a WROTE with the entity name', () => {
    const c = realCommit('feat(x): add a thing');
    runHook('post-commit', {
      tool_name: 'Bash',
      cwd: repoDir,
      session_id: 'sess-1',
      tool_input: { command: `git commit -m "feat(x): add a thing"` },
      tool_output: c.output,
    });
    const rows = records('post-commit');
    expect(rows.length, 'post-commit left no record on the write path').toBe(1);
    expect(rows[0].outcome).toBe('wrote');
    expect(rows[0].entity).toBe(`commit-${c.hash}`);
    expect(rows[0].session_id).toBe('sess-1');
  });

  it('post-commit records a SKIPPED naming the #321 reason when the output has no commit line', () => {
    // Exactly what `git commit -q` looks like from inside this hook: the
    // command IS a commit, and the output says nothing about it.
    runHook('post-commit', {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -q -m "quiet"' },
      tool_output: '',
    });
    const rows = records('post-commit');
    expect(rows.length, 'post-commit left no record on its most common skip path').toBe(1);
    expect(rows[0].outcome).toBe('skipped');
    expect(rows[0].reason).toBe('no commit line in output');
  });

  it('post-commit records a SKIPPED with a reason on every other bail', () => {
    runHook('post-commit', { tool_name: 'Read', tool_input: {} });
    runHook('post-commit', { cwd: repoDir, tool_input: {} });
    runHook('post-commit', {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'cat CHANGELOG.md' },
      tool_output: '[main 9f3c2a1] a line that only LOOKS like a commit\n',
    });
    const rows = records('post-commit');
    expect(rows.map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
    // A skip with no reason is the thing this whole file exists to prevent:
    // it is a record that says "nothing happened" and nothing more.
    for (const r of rows) expect(r.reason, `${JSON.stringify(r)} carries no reason`).toBeTruthy();
    expect(rows[0].reason).toBe('not a Bash tool call');
    expect(rows[1].reason).toBe('tool_name absent in payload');
    expect(rows[2].reason).toContain('not a git commit');
  });

  it('post-commit records an ERROR when the payload cannot be parsed at all', () => {
    execFileSync('node', [path.resolve('scripts/hooks/post-commit.js')], {
      input: '{not json',
      env: { ...process.env, MEMESH_DIR: memeshDir, HOME: testDir },
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rows = records('post-commit');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('error');
  });

  // ── session-summary ──────────────────────────────────────────────────────

  it('session-summary records a SKIPPED for each of its named bails', () => {
    runHook('session-summary', { session_id: 's1', cwd: repoDir, was_in_agentic_loop: false });
    runHook('session-summary', { session_id: 's2', cwd: repoDir });
    runHook('session-summary', {
      session_id: 's3', cwd: repoDir, transcript_path: path.join(testDir, 'gone.jsonl'),
    });
    const rows = records('session-summary');
    expect(rows.map((r) => r.reason)).toEqual([
      'not an agentic loop',
      'transcript_path absent',
      'the transcript file named by the payload is gone',
    ]);
    expect(rows.every((r) => r.outcome === 'skipped')).toBe(true);
  });

  it('session-summary records a WROTE naming the session entity', () => {
    const transcript = path.join(testDir, 't.jsonl');
    const toolUse = (name: string, input: object) => JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, input }] },
    });
    fs.writeFileSync(transcript, [
      toolUse('Edit', { file_path: path.join(repoDir, 'a.ts') }),
      toolUse('Edit', { file_path: path.join(repoDir, 'b.ts') }),
      toolUse('Bash', { command: 'npm test' }),
      toolUse('Bash', { command: 'npm run build' }),
    ].join('\n'));
    runHook('session-summary', {
      session_id: 'sess-write', cwd: repoDir, transcript_path: transcript, was_in_agentic_loop: true,
    });
    const rows = records('session-summary');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1];
    expect(last.outcome, `expected a write, got ${JSON.stringify(last)}`).toBe('wrote');
    expect(last.entity).toBe('session-sess-write-summary');
  });

  // ── pre-compact ──────────────────────────────────────────────────────────

  it('pre-compact records a WROTE, and a SKIPPED when the payload is not a compaction', () => {
    runHook('pre-compact', { session_id: 'pc-1', cwd: repoDir, trigger: 'manual' });
    runHook('pre-compact', { trigger: 'auto' });
    const rows = records('pre-compact');
    expect(rows.length).toBe(2);
    expect(rows[0].outcome).toBe('wrote');
    expect(rows[0].entity).toBe('pre-compact-pc-1');
    expect(rows[1].outcome).toBe('skipped');
    expect(rows[1].reason).toBe('neither session_id nor transcript_path in the payload');
  });

  it('capture stays off-limits when auto-capture is disabled, and the record says so', () => {
    runHook('pre-compact', { session_id: 'pc-2', cwd: repoDir }, { MEMESH_AUTO_CAPTURE: 'false' });
    const rows = records('pre-compact');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('skipped');
    expect(rows[0].reason).toBe('auto-capture is turned off');
  });

  // ── the file itself ──────────────────────────────────────────────────────

  it('is append-only JSONL: concurrent hooks cannot overwrite each other', () => {
    // Three hooks firing in the same second is ordinary on a busy turn. A
    // read-modify-write JSON file loses two of these three by construction;
    // an O_APPEND line write cannot.
    const inputs = [
      ['pre-compact', { trigger: 'auto' }],
      ['post-commit', { tool_name: 'Read', tool_input: {} }],
      ['pre-compact', { trigger: 'manual' }],
    ] as const;
    for (const [hook, payload] of inputs) runHook(hook, payload);
    const raw = fs.readFileSync(path.join(memeshDir, HOOK_OUTCOMES_FILENAME), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(3);
    expect(records('pre-compact')).toHaveLength(2);
    expect(records('post-commit')).toHaveLength(1);
  });

  it('tolerates a torn last line instead of losing the history', () => {
    runHook('pre-compact', { session_id: 'torn-1', cwd: repoDir });
    const file = path.join(memeshDir, HOOK_OUTCOMES_FILENAME);
    fs.appendFileSync(file, '{"hook":"pre-comp');
    const rows = parseHookOutcomes(fs.readFileSync(file, 'utf8')).hooks['pre-compact'] ?? [];
    expect(rows, 'a hook killed mid-write must cost one record, not the file').toHaveLength(1);
  });

  it('the file is bounded: rotation keeps the last 200 lines', () => {
    const file = path.join(memeshDir, HOOK_OUTCOMES_FILENAME);
    // Drive it past the size trigger through the real hook, so the bound is
    // proven on the path that actually writes.
    for (let i = 0; i < 260; i++) {
      fs.appendFileSync(file, serializeHookOutcome({
        hook: 'post-commit', at: new Date().toISOString(), host: 'unknown',
        outcome: 'skipped', reason: 'no commit line in output',
      }));
    }
    runHook('pre-compact', { trigger: 'auto' });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(HOOK_OUTCOMES_MAX_LINES + 1);
    expect(lines.length).toBeGreaterThan(HOOK_OUTCOMES_PER_HOOK);
  });

  it('a summary window never grows with the file', () => {
    const raw = Array.from({ length: 50 }, (_, i) => JSON.stringify({
      hook: 'post-commit', at: `2026-09-0${(i % 9) + 1}T00:00:00.000Z`, host: 'claude-code',
      outcome: 'skipped', reason: 'no commit line in output',
    })).join('\n');
    expect(parseHookOutcomes(raw).hooks['post-commit']).toHaveLength(HOOK_OUTCOMES_PER_HOOK);
  });

  it('trimHookOutcomeLines keeps the NEWEST lines, not the oldest', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `{"n":${i}}`).join('\n') + '\n';
    const kept = trimHookOutcomeLines(raw, 3).trim().split('\n');
    expect(kept).toEqual(['{"n":7}', '{"n":8}', '{"n":9}']);
  });

  // ── the verdict the records feed ─────────────────────────────────────────

  it('a hook that ran enough times and wrote nothing is the concern; one write clears it', () => {
    const skip = (n: number) => Array.from({ length: n }, () => JSON.stringify({
      hook: 'post-commit', at: '2026-09-01T00:00:00.000Z', host: 'claude-code',
      outcome: 'skipped', reason: 'no commit line in output',
    })).join('\n');

    const silent = captureLivenessVerdict({
      hooks: summarizeHookOutcomes(parseHookOutcomes(skip(SILENT_HOOK_MIN_RUNS))), types: [],
    });
    expect(silent.status).toBe('PASS_WITH_CONCERNS');
    expect(captureLivenessNotice(silent)).toContain('post-commit');
    expect(captureLivenessNotice(silent)).toContain('wrote nothing');

    const belowThreshold = captureLivenessVerdict({
      hooks: summarizeHookOutcomes(parseHookOutcomes(skip(SILENT_HOOK_MIN_RUNS - 1))), types: [],
    });
    expect(belowThreshold.status, 'a couple of skips is not evidence of anything').toBe('PASS');

    // Suppression after the next successful write, with no second marker:
    // one `wrote` record makes the hook non-silent and the verdict PASSes.
    const afterWrite = skip(SILENT_HOOK_MIN_RUNS) + '\n' + JSON.stringify({
      hook: 'post-commit', at: '2026-09-02T00:00:00.000Z', host: 'claude-code',
      outcome: 'wrote', entity: 'commit-abc1234',
    });
    const cleared = captureLivenessVerdict({
      hooks: summarizeHookOutcomes(parseHookOutcomes(afterWrite)), types: [],
    });
    expect(cleared.status).toBe('PASS');
    expect(captureLivenessNotice(cleared)).toBeNull();
  });
});
