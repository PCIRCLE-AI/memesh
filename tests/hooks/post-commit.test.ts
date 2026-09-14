import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { HOOK_OUTCOMES_FILENAME } from '../../src/core/capture-liveness.js';

/**
 * The columns these assertions read off a `SELECT`. better-sqlite3 types
 * `.get()` and `.all()` as `unknown` — correctly, since it cannot know the
 * shape of an arbitrary query — so a test that reads columns has to say which
 * ones it is reading. Stating it here is the test declaring its own contract
 * with the schema; before this file was type-checked, it declared nothing and
 * `entity.typo` would have compiled.
 */
type Row = {
  id: number;
  name: string;
  type: string;
  title: string | null;
  metadata: string | null;
  content: string;
  tag: string;
};

describe('Feature: Post-Commit Hook', () => {
  let testDir: string;
  let dbPath: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-test-'));
    dbPath = path.join(testDir, 'test.db');

    // A REAL git repository, because the hook now refuses a hash it cannot
    // find in the repo it was told about. These tests used to pass a made-up
    // `cwd` and a made-up hash and assert that a memory was written — which is
    // precisely the defect the P7 audit caught: `cat`-ing a changelog whose
    // text contained a commit line produced a permanent memory for a commit
    // that never existed. The old fixture encoded the bug as the contract.
    repoDir = path.join(testDir, 'repo');
    fs.mkdirSync(repoDir);
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  });

  function git(args: string[]): string {
    return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', timeout: 15000 });
  }

  /**
   * Make a real commit and hand back exactly what git printed, so the hook is
   * fed the same text a user's terminal would show.
   */
  function commit(message: string, branch = 'main'): { hash: string; output: string } {
    if (branch !== 'main') git(['checkout', '-q', '-b', branch]);
    const file = path.join(repoDir, `f${Date.now()}${Math.round(performance.now())}.txt`);
    fs.writeFileSync(file, 'content\n');
    git(['add', '-A']);
    const output = git(['commit', '-q', '-m', message, '--no-verify']) || '';
    const hash = git(['rev-parse', '--short', 'HEAD']).trim();
    const isFirst = git(['rev-list', '--count', 'HEAD']).trim() === '1';
    // git's own line shape, including the (root-commit) note on the first one.
    const line = isFirst
      ? `[${branch} (root-commit) ${hash}] ${message}`
      : `[${branch} ${hash}] ${message}`;
    return { hash, output: output + line + '\n 1 file changed, 1 insertion(+)\n' };
  }

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function runHook(input: object, env: NodeJS.ProcessEnv = {}): void {
    const hookPath = path.resolve('scripts/hooks/post-commit.js');
    const jsonInput = JSON.stringify(input);
    execFileSync('node', [hookPath], {
      input: jsonInput,
      env: { ...process.env, ...env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  function spawnHook(input: object) {
    const child = spawn(process.execPath, [path.resolve('scripts/hooks/post-commit.js')], {
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify(input));
    return new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`hook exit ${code}: ${stderr}`)));
    });
  }

  function openDb(): Database {
    return new Database(dbPath, { readOnly: true });
  }

  function outcomes(): Array<Record<string, unknown>> {
    const file = path.join(testDir, HOOK_OUTCOMES_FILENAME);
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  it('Scenario: a first quiet commit with an explicit successful tool response -> entity created from HEAD', () => {
    const baseline = commit('chore: establish hook baseline');
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -q -m "chore: establish hook baseline"' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isError: false },
    });

    const firstDb = openDb();
    const first = firstDb.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${baseline.hash}`) as Row;
    firstDb.close();
    expect(first, 'the explicit successful PostToolUse response must make the first quiet HEAD attributable').toBeTruthy();

    const captured = commit('fix: capture quiet commit');
    runHook({
      tool_name: 'Bash',
      session_id: 'quiet-session',
      cwd: repoDir,
      tool_input: { command: 'git commit -q -m "fix: capture quiet commit" >commit.log' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isError: false },
    });

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${captured.hash}`) as Row;
    db.close();
    expect(entity, 'the changed HEAD must be captured even when the command prints nothing').toBeTruthy();
    expect(entity.type).toBe('commit');
    expect(entity.title).toBe('fix: capture quiet commit');
  });

  it.each([{ isError: true }, { interrupted: true }])('Scenario: first-event failure flags %j cannot promote stale output into a capture', (flags) => {
    const existing = commit('chore: existing history before first hook');
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -m failed' },
      tool_response: { stdout: `[main ${existing.hash}] stale output`, ...flags },
    });
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(outcomes().at(-1)).toMatchObject({
      outcome: 'skipped',
      reason: 'recorded the repository HEAD baseline; no history was backfilled',
    });
  });

  it('Scenario: a first quiet legacy payload only establishes a baseline', () => {
    const baseline = commit('chore: legacy baseline');
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -q -m "chore: legacy baseline"' },
      tool_output: '',
    });
    expect(fs.existsSync(dbPath), `legacy output cannot prove ${baseline.hash} was created by this command`).toBe(false);
    expect(outcomes().at(-1)?.reason).toBe('recorded the repository HEAD baseline; no history was backfilled');
  });

  it('Scenario: the repository marker lock covers state selection and capture, not only the final rename', async () => {
    commit('chore: establish locked baseline');
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -q -m baseline' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isError: false },
    });
    const markerDir = path.join(testDir, 'post-commit-heads');
    const marker = fs.readdirSync(markerDir).find(name => name.endsWith('.json'))!;
    const lock = path.join(markerDir, `${marker}.lock`);
    fs.writeFileSync(lock, 'external test owner', { mode: 0o600, flag: 'wx' });
    const next = commit('fix: serialize state selection');
    const running = spawnHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -q -m serialize' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isError: false },
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    const blockedDb = openDb();
    const beforeRelease = blockedDb.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${next.hash}`);
    blockedDb.close();
    expect(beforeRelease, 'capture ran before it owned the marker lock').toBeUndefined();
    fs.unlinkSync(lock);
    await running;
    const capturedDb = openDb();
    const afterRelease = capturedDb.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${next.hash}`);
    capturedDb.close();
    expect(afterRelease, 'capture did not resume after the marker lock was released').toBeTruthy();
  });

  it('Scenario: a live lock owner produces an error outcome before the host timeout', () => {
    commit('chore: establish timeout baseline');
    const input = {
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -q -m baseline' },
      tool_response: { stdout: '', stderr: '', isError: false },
    };
    runHook(input);
    const markerDir = path.join(testDir, 'post-commit-heads');
    const marker = fs.readdirSync(markerDir).find(name => name.endsWith('.json'))!;
    const lock = path.join(markerDir, `${marker}.lock`);
    const owner = JSON.stringify({ pid: process.pid, token: 'live-test-owner' });
    fs.writeFileSync(lock, owner, { mode: 0o600, flag: 'wx' });
    const before = outcomes().length;
    const configured = JSON.parse(fs.readFileSync('hooks/hooks.json', 'utf8'));
    const installed = configured.hooks.PostToolUse.flatMap((entry: any) => entry.hooks)
      .find((entry: any) => entry.command.includes('post-commit.js'));
    const result = spawnSync(process.execPath, [path.resolve('scripts/hooks/post-commit.js')], {
      input: JSON.stringify(input), encoding: 'utf8',
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      timeout: installed.timeout * 1000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('timed out waiting for post-commit state lock');
    expect(outcomes()).toHaveLength(before + 1);
    expect(outcomes().at(-1)?.outcome).toBe('error');
    expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
  });

  it('Scenario: an abandoned marker lock is recovered by process identity without age-based stealing', () => {
    commit('chore: establish recoverable baseline');
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -q -m baseline' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isError: false },
    });
    const markerDir = path.join(testDir, 'post-commit-heads');
    const marker = fs.readdirSync(markerDir).find(name => name.endsWith('.json'))!;
    const lock = path.join(markerDir, `${marker}.lock`);
    fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: 'abandoned-test-owner' }), { mode: 0o600, flag: 'wx' });
    const next = commit('fix: recover abandoned owner');
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -q -m recover' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isError: false },
    });
    const db = openDb();
    const captured = db.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${next.hash}`);
    db.close();
    expect(captured).toBeTruthy();
    expect(fs.existsSync(lock), 'recovered lock was left behind').toBe(false);
  });

  it('Scenario: failed commit with stale commit-shaped output cannot override an unchanged HEAD', () => {
    const existing = commit('chore: existing commit');
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -q -m existing' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isError: false },
    });
    const before = outcomes().length;
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -m failed' },
      tool_response: {
        stdout: `[main ${existing.hash}] stale wrapper output`,
        stderr: 'nothing to commit',
        interrupted: false,
        isError: true,
      },
    });
    const rows = outcomes();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      outcome: 'skipped',
      reason: 'a commit-like command completed but repository HEAD did not change',
    });
  });

  it('Scenario: unresolved Git state cannot turn stale terminal output into a commit', () => {
    const existing = commit('chore: establish state-error baseline');
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -q -m baseline' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isError: false },
    });
    const fakeBin = path.join(testDir, 'fake-bin');
    fs.mkdirSync(fakeBin);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const fakeGit = path.join(fakeBin, 'git');
    fs.writeFileSync(fakeGit, `#!/usr/bin/env node\nconst { spawnSync } = require('child_process');\nconst args = process.argv.slice(2);\nif (args.includes('--verify') && args.at(-1) === 'HEAD') process.exit(1);\nconst r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\nprocess.exit(r.status ?? 1);\n`);
    fs.chmodSync(fakeGit, 0o755);
    const before = outcomes().length;
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -m failed' },
      tool_response: {
        stdout: `[main ${existing.hash}] stale wrapper output`,
        stderr: 'git state became unavailable',
        interrupted: false,
        isError: true,
      },
    }, { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` });
    const rows = outcomes();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      outcome: 'skipped',
      reason: 'a commit-like command ran but repository HEAD could not be resolved',
    });
  });

  it('Scenario: a commit-producing command captures every newly reachable commit as one bounded batch', () => {
    commit('chore: establish batch baseline');
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -q -m baseline' },
      tool_response: { stdout: '', stderr: '', isError: false },
    });

    const first = commit('feat: first hidden commit');
    const second = commit('feat: second hidden commit');
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git merge feature --no-edit >merge.log' },
      tool_response: { stdout: '', stderr: '', isError: false },
    });

    const db = openDb();
    const names = (db.prepare("SELECT name FROM entities WHERE type = 'commit' ORDER BY id").all() as Row[])
      .map((row) => row.name);
    for (const hash of [first.hash, second.hash]) expect(names).toContain(`commit-${hash}`);
    const batchTags = (db.prepare("SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.type = 'commit' AND t.tag = 'origin:batch'").all() as Row[]);
    db.close();
    expect(batchTags).toHaveLength(2);
  });

  it('Scenario: a large reachable range captures only the newest 20 and records the skipped count', () => {
    commit('chore: establish cap baseline');
    runHook({
      tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -q -m baseline' }, tool_output: '',
    });
    const commits = Array.from({ length: 22 }, (_, index) => commit(`feat: hidden batch ${index + 1}`));
    runHook({
      tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git cherry-pick range >result.log' }, tool_output: '',
    });

    const db = openDb();
    const names = new Set((db.prepare("SELECT name FROM entities WHERE type = 'commit'").all() as Row[]).map((row) => row.name));
    db.close();
    expect(names).toHaveLength(20);
    expect(names.has(`commit-${commits[0].hash}`)).toBe(false);
    expect(names.has(`commit-${commits[1].hash}`)).toBe(false);
    expect(names.has(`commit-${commits.at(-1)!.hash}`)).toBe(true);
    expect(outcomes().at(-1)?.reason).toBe('captured 20 commits as a batch; skipped 2 older commits');
  });

  it('Scenario: linked worktrees keep independent positions inside one repository marker', () => {
    commit('chore: establish common-dir baseline');
    runHook({
      tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -q -m baseline' }, tool_output: '',
    });
    const worktree = path.join(testDir, 'worktree');
    git(['worktree', 'add', '-q', '-b', 'feature/worktree-capture', worktree]);
    fs.writeFileSync(path.join(worktree, 'worktree.txt'), 'captured\n');
    execFileSync('git', ['-C', worktree, 'add', 'worktree.txt']);
    execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', 'feat: capture from worktree', '--no-verify']);
    const hash = execFileSync('git', ['-C', worktree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    runHook({
      tool_name: 'Bash', cwd: worktree,
      tool_input: { command: 'git commit -q -m "feat: capture from worktree"' }, tool_output: '',
    });

    const db = openDb();
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(`commit-${hash}`);
    db.close();
    expect(entity).toBeTruthy();
    const markers = fs.readdirSync(path.join(testDir, 'post-commit-heads'));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    const marker = JSON.parse(fs.readFileSync(path.join(testDir, 'post-commit-heads', markers[0]), 'utf8'));
    expect(Object.keys(marker.heads)).toHaveLength(2);
  });

  it('Scenario: alternating divergent linked worktrees capture each new HEAD without replaying a duplicate', () => {
    commit('chore: establish alternating baseline');
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -q -m baseline' }, tool_output: '' });

    const worktree = path.join(testDir, 'alternating-worktree');
    git(['worktree', 'add', '-q', '-b', 'feature/alternating', worktree]);
    const commitIn = (cwd: string, filename: string, message: string): string => {
      fs.writeFileSync(path.join(cwd, filename), `${message}\n`);
      execFileSync('git', ['-C', cwd, 'add', filename]);
      execFileSync('git', ['-C', cwd, 'commit', '-q', '-m', message, '--no-verify']);
      return execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    };

    const firstWorktree = commitIn(worktree, 'worktree-one.txt', 'feat: first worktree commit');
    runHook({ tool_name: 'Bash', cwd: worktree, tool_input: { command: 'git commit -q -m first' }, tool_output: '' });
    const mainCommit = commit('feat: divergent main commit');
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -q -m main' }, tool_output: '' });
    const secondWorktree = commitIn(worktree, 'worktree-two.txt', 'feat: second worktree commit');
    runHook({ tool_name: 'Bash', cwd: worktree, tool_input: { command: 'git commit -q -m second' }, tool_output: '' });

    const db = openDb();
    const names = new Set((db.prepare("SELECT name FROM entities WHERE type = 'commit'").all() as Row[]).map((row) => row.name));
    db.close();
    for (const hash of [firstWorktree, mainCommit.hash, secondWorktree]) expect(names.has(`commit-${hash}`)).toBe(true);
    expect(outcomes().at(-1)?.outcome).toBe('wrote');
  });

  it('Scenario: a rebased worktree uses another proven ancestor instead of replaying rewritten history', () => {
    commit('chore: establish rebase baseline');
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -q -m baseline' }, tool_output: '' });
    const worktree = path.join(testDir, 'rebased-worktree');
    git(['worktree', 'add', '-q', '-b', 'feature/rebased', worktree]);

    fs.writeFileSync(path.join(worktree, 'before-rebase.txt'), 'old\n');
    execFileSync('git', ['-C', worktree, 'add', 'before-rebase.txt']);
    execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', 'feat: before rebase', '--no-verify']);
    runHook({ tool_name: 'Bash', cwd: worktree, tool_input: { command: 'git commit -q -m old' }, tool_output: '' });

    const mainCommit = commit('feat: advance main for rebase');
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -q -m main' }, tool_output: '' });
    execFileSync('git', ['-C', worktree, 'rebase', 'main']);
    const rebasedHash = execFileSync('git', ['-C', worktree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(worktree, 'after-rebase.txt'), 'new\n');
    execFileSync('git', ['-C', worktree, 'add', 'after-rebase.txt']);
    execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', 'feat: after rebase', '--no-verify']);
    const afterRebaseHash = execFileSync('git', ['-C', worktree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    runHook({ tool_name: 'Bash', cwd: worktree, tool_input: { command: 'git commit -q -m new' }, tool_output: '' });

    const db = openDb();
    const names = new Set((db.prepare("SELECT name FROM entities WHERE type = 'commit'").all() as Row[]).map((row) => row.name));
    db.close();
    expect(names.has(`commit-${mainCommit.hash}`)).toBe(true);
    expect(names.has(`commit-${rebasedHash}`)).toBe(true);
    expect(names.has(`commit-${afterRebaseHash}`)).toBe(true);
    expect(outcomes().at(-1)?.outcome).toBe('wrote');
  });

  it('Scenario: real merge, cherry-pick and revert commands each capture the commits they create', () => {
    commit('chore: establish command baseline');
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -q -m baseline' }, tool_output: '' });

    git(['checkout', '-q', '-b', 'feature/merge-source']);
    const featureFile = path.join(repoDir, 'merged.txt');
    fs.writeFileSync(featureFile, 'merge\n');
    git(['add', 'merged.txt']);
    git(['commit', '-q', '-m', 'feat: merge source', '--no-verify']);
    const featureHash = git(['rev-parse', '--short', 'HEAD']).trim();
    git(['checkout', '-q', 'main']);
    git(['merge', '--no-ff', '-q', '-m', 'merge: feature source', 'feature/merge-source']);
    const mergeHash = git(['rev-parse', '--short', 'HEAD']).trim();
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git merge --no-ff feature/merge-source' }, tool_output: '' });

    git(['checkout', '-q', '-b', 'feature/pick-source']);
    fs.writeFileSync(path.join(repoDir, 'picked.txt'), 'pick\n');
    git(['add', 'picked.txt']);
    git(['commit', '-q', '-m', 'feat: pick source', '--no-verify']);
    const sourceHash = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', 'main']);
    git(['cherry-pick', sourceHash]);
    const pickedHash = git(['rev-parse', '--short', 'HEAD']).trim();
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: `git cherry-pick ${sourceHash}` }, tool_output: '' });

    const revertedTarget = commit('fix: target later reverted');
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -m "fix: target later reverted"' }, tool_output: revertedTarget.output });
    git(['revert', '--no-edit', 'HEAD']);
    const revertHash = git(['rev-parse', '--short', 'HEAD']).trim();
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git revert --no-edit HEAD~1' }, tool_output: '' });

    const db = openDb();
    const names = new Set((db.prepare("SELECT name FROM entities WHERE type = 'commit'").all() as Row[]).map((row) => row.name));
    db.close();
    for (const hash of [featureHash, mergeHash, pickedHash, revertedTarget.hash, revertHash]) {
      expect(names.has(`commit-${hash}`), `${hash} was not captured`).toBe(true);
    }
  });

  it('Scenario: a failed commit-like command leaves an unchanged-HEAD outcome and no entity', () => {
    commit('chore: establish failed-command baseline');
    runHook({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -q -m baseline' }, tool_output: '' });
    runHook({
      tool_name: 'Bash', cwd: repoDir,
      tool_input: { command: 'git commit -m "nothing staged"' },
      tool_response: { stdout: '', stderr: 'nothing to commit', isError: true },
    });

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(outcomes().at(-1)?.reason).toBe('a commit-like command completed but repository HEAD did not change');
  });

  it('Scenario: a repo FIRST commit (root-commit note) -> entity created', () => {
    const c = commit('feat(auth): add PKCE flow');
    // git prints `[master (root-commit) 32e98b8] ...` for the first commit of
    // every repository, and the old pattern required branch-then-hash with
    // nothing between — so no repo's first commit was ever remembered, with
    // zero trace. Measured live in the P7 audit.
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat(auth): add PKCE flow"' },
      tool_output: c.output,
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${c.hash}`) as Row;
    db.close();
    expect(entity, 'the first commit of a repository must be remembered like any other').toBeTruthy();
    expect(entity.type).toBe('commit');
  });

  it('Scenario: Bash output with git commit -> entity created', () => {
    const c = commit('fix: resolve login bug');
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "fix: resolve login bug"' },
      tool_output: c.output,
    };

    runHook(input);

    // Verify entity was created
    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${c.hash}`) as Row;
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('commit');

    // Verify observation
    const obs = db.prepare('SELECT * FROM observations WHERE entity_id = ?').get(entity.id) as Row;
    expect(obs).toBeTruthy();
    expect(obs.content).toBe('fix: resolve login bug');

    // Verify tag
    const tag = db.prepare("SELECT * FROM tags WHERE entity_id = ? AND tag LIKE 'project:%'").get(entity.id) as Row;
    expect(tag?.tag).toMatch(/^project:repo~[0-9a-f]{32}$/);

    // Verify FTS
    const fts = db.prepare("SELECT * FROM entities_fts WHERE entities_fts MATCH 'login'").all() as Row[];
    expect(fts.length).toBeGreaterThan(0);

    db.close();
  });

  it('Scenario: the commit subject becomes the entity title, marked heuristic', () => {
    // UX-1: a commit subject is already the human-written one-line summary,
    // so it IS the title. The heuristic mark records that MeMesh derived the
    // title rather than receiving a separately edited human label.
    const c = commit('refactor(db): collapse the tuple cache');
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "refactor(db): collapse the tuple cache"' },
      tool_output: c.output,
    });

    const db = openDb();
    const entity = db.prepare('SELECT title, metadata FROM entities WHERE name = ?').get(`commit-${c.hash}`) as Row;
    db.close();
    expect(entity.title).toBe('refactor(db): collapse the tuple cache');
    expect(JSON.parse(entity.metadata as string).title_source).toBe('heuristic');
  });

  it('Scenario: session id and touched files land in metadata — the hop `memesh why` walks', () => {
    // Metadata, not tags, deliberately: a `file:*` tag on a commit entity
    // would make pre-edit-recall inject commit noise into every edit of a
    // touched file (its Strategy 1 joins on exactly that tag).
    fs.writeFileSync(path.join(repoDir, 'auth.ts'), 'export const a = 1;\n');
    git(['add', '--', 'auth.ts']);
    git(['commit', '-q', '-m', 'feat: add auth', '--no-verify']);
    const hash = git(['rev-parse', '--short', 'HEAD']).trim();

    runHook({
      tool_name: 'Bash',
      session_id: 'sess-why-1',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat: add auth"' },
      tool_output: `[main (root-commit) ${hash}] feat: add auth\n 1 file changed, 1 insertion(+)\n`,
    });

    const db = openDb();
    const entity = db.prepare('SELECT metadata FROM entities WHERE name = ?').get(`commit-${hash}`) as Row;
    db.close();
    const meta = JSON.parse(entity.metadata as string);
    expect(meta.session_id).toBe('sess-why-1');
    expect(meta.files).toContain('auth.ts');
    // The extra metadata must not displace the stamps captureEntity owns.
    expect(meta.provenance.source_host).toBe('claude-code');
    expect(meta.title_source).toBe('heuristic');
  });

  it('Scenario: output that LOOKS like a commit, from a command that was not one -> nothing written', () => {
    // The P7 defect, pinned. Reading a changelog whose text happens to contain
    // git's `[branch hash] message` line used to write a permanent memory for a
    // commit that never existed — the hook matched on the OUTPUT and never
    // looked at the command. Reproduced before the fix: a payload whose command
    // was `cat docs/release-notes.md` produced entity `commit-9f3c2a1`, for a
    // hash `git cat-file -t` rejects.
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'cat docs/release-notes.md' },
      tool_response: { stdout: '[main 9f3c2a1] fix(db): drop the vec table\n' },
    });
    expect(fs.existsSync(dbPath), 'a fabricated commit was written to the graph').toBe(false);
  });

  it('Scenario: a REAL commit line, echoed by a command that was not a commit -> nothing written', () => {
    // Separates the two guards. The hash here genuinely exists in this repo, so
    // the existence check cannot be what rejects it — only the command check
    // can. Without this, removing the command check still passed, because the
    // fabricated-hash test was being killed by the other guard.
    const c = commit('a real commit, quoted later');
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git log --oneline -1' },
      tool_response: { stdout: c.output },
    });
    expect(fs.existsSync(dbPath), 'quoting a real commit line was enough to write a memory').toBe(false);
  });

  it('Scenario: a git commit for a hash that is not in THIS repo -> nothing written', () => {
    // The second half of the same guard. The command is a real `git commit`,
    // but the hash belongs to some other repository — which is what a copied
    // terminal line, or a commit in a sibling checkout, looks like. Writing it
    // would file a real-looking memory against the wrong project.
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "from somewhere else"' },
      tool_response: { stdout: '[main 0123abc] from somewhere else\n' },
    });
    expect(fs.existsSync(dbPath), 'a commit from another repo was written').toBe(false);
  });

  it('Scenario: Bash output without git commit -> no entity created', () => {
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'ls -la' },
      tool_output: 'total 32\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 .',
    };

    runHook(input);

    // Database should not even exist (no commit detected)
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('Scenario: Non-Bash tool -> exits cleanly without action', () => {
    const input = {
      tool_name: 'Read',
      cwd: repoDir,
      tool_input: { file_path: '/tmp/test.txt' },
      tool_output: 'file contents',
    };

    runHook(input);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('Scenario: Database does not exist -> creates it and stores commit', () => {
    const c = commit('initial commit');
    expect(fs.existsSync(dbPath)).toBe(false);

    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "initial commit"' },
      tool_output: c.output,
    };

    runHook(input);

    expect(fs.existsSync(dbPath)).toBe(true);
    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${c.hash}`) as Row;
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('commit');
    db.close();
  });

  it('Scenario: Branch name with slashes -> commit detected correctly', () => {
    const c = commit('feat: add feature', 'feature/v3-hooks');
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat: add feature"' },
      tool_output: c.output,
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${c.hash}`) as Row;
    expect(entity).toBeTruthy();
    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ?').get(entity.id) as Row;
    expect(obs.content).toBe('feat: add feature');
    db.close();
  });

  it('Scenario: Duplicate commit -> no duplicate entities', () => {
    const c = commit('same commit');
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "same commit"' },
      tool_output: c.output,
    };

    runHook(input);
    runHook(input);

    const db = openDb();
    const entities = db.prepare('SELECT * FROM entities WHERE name = ?').all(`commit-${c.hash}`) as Row[];
    expect(entities).toHaveLength(1);
    // Two tags — `project:<name>` and the `source:auto-capture` provenance
    // marker every capture hook writes — and each exactly once. The point of
    // the assertion is that a second run does not re-insert them, so it is
    // written as "no duplicates" rather than a bare count: a count alone goes
    // stale the moment the tag set changes, which is what happened when
    // provenance was added.
    const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(entities[0].id) as Row[])
      .map((t) => (t as unknown as { tag: string }).tag);
    expect(new Set(tags).size, `duplicate tags after two runs: ${tags.join(', ')}`).toBe(tags.length);
    expect(tags).toContain('source:auto-capture');
    // But observations may be duplicated (each hook run adds one)
    const obs = db.prepare('SELECT * FROM observations WHERE entity_id = ?').all(entities[0].id) as Row[];
    expect(obs.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('Scenario: Branch name extracted from commit output -> stored as observation', () => {
    const c = commit('feat: new feature', 'feature/my-branch');
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat: new feature"' },
      tool_output: c.output,
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${c.hash}`) as Row;
    expect(entity).toBeTruthy();
    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entity.id) as Row[];
    const branchObs = obs.find((o: { content: string }) => o.content.startsWith('Branch:'));
    expect(branchObs).toBeTruthy();
    expect(branchObs!.content).toBe('Branch: feature/my-branch');
    db.close();
  });

  it('Scenario: Hook writes nothing to stdout', () => {
    // Was 'Hook output includes suppressOutput flag', asserting
    // `{"suppressOutput": true}`. That is valid Claude Code hook output, and
    // Codex CLI rejects it per event — "PostToolUse hook returned unsupported
    // suppressOutput", once per Bash call, with the capture already done. The
    // field suppressed nothing (this hook has no other stdout write), so the
    // portable answer is silence, which both contracts read as "no opinion".
    const c = commit('fix: something');
    const hookPath = path.resolve('scripts/hooks/post-commit.js');
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "fix: something"' },
      tool_output: c.output,
    };
    const result = execFileSync('node', [hookPath], {
      input: JSON.stringify(input),
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.trim(), 'stdout must stay empty — see tests/hooks/cross-host-output-contract.test.ts').toBe('');
  });

  it('Scenario: Invalid JSON input -> exits cleanly', () => {
    const hookPath = path.resolve('scripts/hooks/post-commit.js');
    // Should not throw
    execFileSync('node', [hookPath], {
      input: 'not-json',
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
  });

  // Regression: Claude Code's PostToolUse hook payload uses
  // `tool_response: { stdout, stderr, ... }` (current schema), not
  // legacy `tool_output: <string>`. The hook silently stopped writing
  // any commit entity once Claude Code unified on this shape, because
  // the hook only consulted `tool_output`. This test pins the new
  // shape so a future refactor can't regress it again.
  it('Scenario: tool_response.stdout (current Claude Code schema) -> entity created', () => {
    const c = commit('feat: tool_response shape');
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat: tool_response shape"' },
      tool_response: {
        stdout: c.output,
        stderr: '',
        interrupted: false,
        isError: false,
      },
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(`commit-${c.hash}`) as Row;
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('commit');
    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entity.id) as Row[];
    const msgObs = obs.find((o: { content: string }) => o.content === 'feat: tool_response shape');
    expect(msgObs).toBeTruthy();
    db.close();
  });

  it('Scenario: a successful capture stamps the hook_runs heartbeat AFTER the write', () => {
    // This hook had NO runtime heartbeat test — its only guard was a source
    // grep, which a stamp moved back before captureEntity would satisfy.
    const c = commit('feat: heartbeat success');
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat: heartbeat success"' },
      tool_output: c.output,
    });

    const db = openDb();
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(`commit-${c.hash}`);
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'post-commit'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(entity, 'capture itself must have happened for the stamp to mean anything').toBeTruthy();
    expect(run, 'a completed capture run must stamp the heartbeat').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it('Scenario: a run that dies mid-capture leaves NO heartbeat', () => {
    // An entities table missing the `metadata` column survives openHookDb
    // (CREATE IF NOT EXISTS; the migration chain only backfills columns it
    // knows) and throws inside captureEntity — the crashed-hook-looks-alive
    // lie must not come back through this hook either.
    const poisoned = new Database(dbPath);
    poisoned.exec(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);
    poisoned.close();

    const c = commit('feat: dies mid-capture');
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat: dies mid-capture"' },
      tool_output: c.output,
    });

    const db = openDb();
    const runs = db.prepare('SELECT hook FROM hook_runs').all();
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(`commit-${c.hash}`);
    db.close();
    expect(entity, 'precondition: capture must actually have failed').toBeUndefined();
    expect(runs, 'a crashed capture run must not look alive').toHaveLength(0);
  });

  it('Scenario: a write that fails WITHOUT throwing leaves no new heartbeat', () => {
    // captureEntity can fail silently: when its INSERT lands nothing (here, a
    // RAISE(IGNORE) trigger swallows it) it returns null instead of throwing.
    // The crash test above cannot see this path — nothing unwinds the stack —
    // so the `if (written)` gate is what keeps a landed-nothing run from
    // stamping itself alive.
    const c1 = commit('feat: first capture');
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat: first capture"' },
      tool_output: c1.output,
    });

    const setup = new Database(dbPath);
    setup.exec('CREATE TRIGGER block_inserts BEFORE INSERT ON entities BEGIN SELECT RAISE(IGNORE); END;');
    setup.close();

    const c2 = commit('feat: swallowed capture');
    runHook({
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat: swallowed capture"' },
      tool_output: c2.output,
    });

    const db = openDb();
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(`commit-${c2.hash}`);
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'post-commit'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(entity, 'precondition: the trigger must actually have swallowed the write').toBeUndefined();
    expect(run!.run_count, 'a run that landed nothing must not stamp on top of the first run').toBe(1);
  });

  it('Scenario: MEMESH_AUTO_CAPTURE=false -> no entity, no heartbeat, no DB', () => {
    // This hook skipped the opt-out check its two siblings honoured — with
    // capture disabled it kept writing commit entities and stamping the
    // heartbeat, making doctor's "capture is off, hook silence is expected"
    // message false.
    const c = commit('feat: capture disabled');
    const hookPath = path.resolve('scripts/hooks/post-commit.js');
    execFileSync('node', [hookPath], {
      input: JSON.stringify({
        tool_name: 'Bash',
        cwd: repoDir,
        tool_input: { command: 'git commit -m "feat: capture disabled"' },
        tool_output: c.output,
      }),
      env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: 'false' },
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(fs.existsSync(dbPath), 'a disabled hook must not even create the database').toBe(false);
  });
  /**
   * #240, widened. This hook runs on PostToolUse, so every later Bash call
   * while HEAD is unchanged rebuilds the same `commit-<sha>` payload. It used
   * to APPEND it: three ACTIVE commit entities on the maintainer's graph stood
   * at 6 observations / 3 distinct, one identical triple re-written 107
   * seconds after the first.
   */
  it('Scenario: re-capturing the same commit appends no duplicate observation', () => {
    const c = commit('feat(auth): add PKCE flow');
    const input = {
      tool_name: 'Bash',
      cwd: repoDir,
      tool_input: { command: 'git commit -m "feat(auth): add PKCE flow"' },
      tool_output: c.output,
    };

    runHook(input);
    const db1 = openDb();
    const first = (db1.prepare(
      'SELECT o.content AS content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
    ).all(`commit-${c.hash}`) as Row[]).map((r) => r.content);
    db1.close();
    expect(first.length, 'the first capture must store the commit').toBeGreaterThan(0);

    // The same tool output seen again — a user scrolling back, a retried Bash
    // call, or simply the next command in the same session.
    runHook(input);
    runHook(input);

    const db = openDb();
    const rows = (db.prepare(
      'SELECT o.content AS content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
    ).all(`commit-${c.hash}`) as Row[]).map((r) => r.content);
    db.close();

    expect(rows).toEqual(first);
    expect(new Set(rows).size, 'every stored line is distinct').toBe(rows.length);
  });
});
