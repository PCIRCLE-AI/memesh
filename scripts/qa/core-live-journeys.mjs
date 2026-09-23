// Isolated, non-interactive journeys used by qa:live-journey.  Host-native
// delivery and packed-upgrade deliberately live in the caller: this module
// owns only daily core behaviour that can run in a task-owned directory.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildCredentialFreeBaseEnv } from '../lib/isolated-env.mjs';

const OUTCOMES = 'hook-outcomes.jsonl';

/** @typedef {{status: number|null, stdout: string, stderr: string}} CliResult */
/** @typedef {(input: {args: string[], env: NodeJS.ProcessEnv, cwd: string, input?: string}) => CliResult} CliRunner */

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`core live journey refused path outside runDir: ${target}`);
  }
  return target;
}

/** @type {CliRunner} */
const defaultCli = ({ args, env, cwd, input }) => {
  return spawnSync(process.execPath, [path.join(cwd, 'dist/transports/cli/cli.js'), ...args], {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: 20_000,
  });
};

function runNode(script, { cwd, env, input }) {
  return spawnSync(process.execPath, [script], { cwd, env, input, encoding: 'utf8', timeout: 20_000 });
}

function mustSucceed(result, label) {
  if (result?.status !== 0) {
    throw new Error(`${label} failed (exit ${result?.status}): ${(result?.stderr || '').trim()}`);
  }
  return result;
}

function json(result, label) {
  try { return JSON.parse(result.stdout.trim()); } catch { throw new Error(`${label} returned invalid JSON: ${result.stdout}`); }
}

function outcomeRows(memeshDir, hook) {
  const file = path.join(memeshDir, OUTCOMES);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((row) => row.hook === hook);
}

function git(repo, args, env) {
  return mustSucceed(spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 15_000 }), `git ${args[0]}`).stdout.trim();
}

function commit(repo, message, env, quiet = false) {
  const file = path.join(repo, `${Date.now()}-${randomBytes(16).toString('hex')}.txt`);
  fs.writeFileSync(file, `${message}\n`);
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', ...(quiet ? ['-q'] : []), '-m', message], env);
  return git(repo, ['rev-parse', '--short', 'HEAD'], env);
}

function result(id, success, failure, effect_readback) {
  return { id, status: 'PASS', boundary: 'isolated-process', success, failure, effect_readback };
}

/**
 * Exercise MeMesh's local daily journeys without touching caller state.
 * `cli` and `step` are injected so the outer release runner can compose one
 * receipt, while the default uses the built candidate's actual CLI process.
 */
/**
 * @param {{
 *   repoRoot: string,
 *   runDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   cli?: CliRunner,
 *   step?: (name: string, execute: () => Promise<any>) => Promise<any>,
 * }} options
 */
export async function runCoreLiveJourneys({ repoRoot, runDir, env = {}, cli = defaultCli, step = async (_name, fn) => fn() }) {
  const resolvedRunDir = fs.realpathSync(runDir);
  const baseEnv = {
    ...buildCredentialFreeBaseEnv({ ...process.env, ...env }),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  // The product resolver invokes Git; give that subprocess the same isolation
  // as the journeys rather than letting it inherit the parent environment.
  const project = mustSucceed(spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { getProjectName } from "./dist/core/paths.js"; process.stdout.write(getProjectName(process.cwd()));',
  ], { cwd: repoRoot, env: { ...baseEnv, HOME: resolvedRunDir, USERPROFILE: resolvedRunDir }, encoding: 'utf8', timeout: 20_000 }), 'project resolution').stdout.trim();
  const evidence = [];
  async function isolatedJourney(id, work) {
    const journeyDir = assertInside(resolvedRunDir, path.join(resolvedRunDir, id));
    const memeshDir = assertInside(journeyDir, path.join(journeyDir, 'memesh'));
    const homeDir = assertInside(journeyDir, path.join(journeyDir, 'home'));
    fs.mkdirSync(memeshDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    // SessionStart normally starts a detached npm-status refresh. It is
    // unrelated to these local journeys and could recreate a just-removed
    // directory, so the isolated user configuration explicitly declines it.
    fs.writeFileSync(path.join(memeshDir, 'config.json'), JSON.stringify({ updateCheck: false }), { mode: 0o600 });
    const isolatedEnv = {
      ...baseEnv,
      // No MEMESH_BRIEFING pin here (issue #412): a real install gets the
      // default level (`minimal`) unless it opts into something else, and
      // that is what these journeys must exercise. Only
      // `session-start-briefing` below cares about the level at all — it
      // adds its own MEMESH_BRIEFING override locally, on top of this env,
      // for the one assertion that needs `standard`.
      HOME: homeDir,
      USERPROFILE: homeDir,
      MEMESH_DIR: memeshDir,
      MEMESH_DB_PATH: path.join(memeshDir, 'knowledge-graph.db'),
      MEMESH_ROUTER_SOCKET: path.join(memeshDir, 'agent-router-v2.sock'),
      MEMESH_ROUTER_TOKEN_FILE: path.join(memeshDir, 'agent-router.token'),
    };
    const invokeCli = (args, input) => cli({ args, env: isolatedEnv, cwd: repoRoot, input });
    let row;
    try {
      row = await work({ journeyDir, memeshDir, isolatedEnv, invokeCli });
    } finally {
      fs.rmSync(journeyDir, { recursive: true, force: true });
    }
    if (fs.existsSync(journeyDir)) throw new Error(`${id} cleanup left its isolated directory behind`);
    return { ...row, cleanup: { status: 'PASS', removed: true, scope: id } };
  }

  evidence.push(await step('memory-round-trip', () => isolatedJourney('memory-round-trip', async ({ invokeCli }) => {
    const sentinel = `core-live-${Date.now()}-${randomBytes(16).toString('hex')}`;
    const remembered = mustSucceed(invokeCli(['remember', sentinel, '--tags', `project:${project}`, '--json']), 'remember');
    const rememberedResult = json(remembered, 'remember');
    const replacement = `${sentinel}-corrected`;
    const recalled = mustSucceed(invokeCli(['recall', sentinel, '--json']), 'recall');
    const recall = json(recalled, 'recall');
    if (!recall.entities?.some((entity) => entity.observations?.includes(sentinel))) throw new Error('remembered sentinel was absent from recall readback');
    const replaced = mustSucceed(invokeCli([
      'remember', '--name', rememberedResult.name, '--replace', '--obs', replacement, '--json',
    ]), 'replace');
    if (json(replaced, 'replace').replaced !== true) throw new Error('replace did not preserve the previous version');
    const replacementReadback = json(
      mustSucceed(invokeCli(['recall', replacement, '--json']), 'replacement recall'),
      'replacement recall',
    );
    if (!replacementReadback.entities?.some((entity) => entity.observations?.includes(replacement))) {
      throw new Error('replacement was absent from recall readback');
    }
    const forgotten = json(
      mustSucceed(invokeCli(['forget', '--name', rememberedResult.name, '--json']), 'forget'),
      'forget',
    );
    if (forgotten.archived !== true) throw new Error('forget did not archive the memory');
    const activeAfterForget = json(
      mustSucceed(invokeCli(['recall', replacement, '--json']), 'post-forget recall'),
      'post-forget recall',
    );
    if (activeAfterForget.entities?.length !== 0) throw new Error('archived memory remained in active recall');
    const archivedReadback = json(
      mustSucceed(invokeCli(['recall', replacement, '--include-archived', '--json']), 'archived recall'),
      'archived recall',
    );
    if (!archivedReadback.entities?.some((entity) => entity.name === rememberedResult.name && entity.archived === true)) {
      throw new Error('archived memory was absent from include-archived readback');
    }
    const invalid = invokeCli(['remember', '--name', 'invalid-core-journey', '--json']);
    if (invalid.status === 0) throw new Error('invalid remember unexpectedly succeeded');
    const missingForget = invokeCli(['forget', '--name', `missing-${sentinel}`, '--json']);
    if (missingForget.status === 0) throw new Error('forget of a missing memory unexpectedly succeeded');
    const absent = mustSucceed(invokeCli(['recall', `no-match-${randomBytes(16).toString('hex')}`, '--json']), 'absent recall');
    if (json(absent, 'absent recall').entities?.length !== 0) throw new Error('absent recall returned an entity');
    return result(
      'memory-round-trip',
      { observed: true, operations: ['remember', 'recall', 'replace', 'forget'] },
      { observed: true, invalidRememberExit: invalid.status, missingForgetExit: missingForget.status, absentCount: 0 },
      { observed: true, remembered: rememberedResult.name, replacementRecalled: true, archivedReadback: true },
    );
  })));

  evidence.push(await step('session-start-briefing', () => isolatedJourney('session-start-briefing', async ({ journeyDir, isolatedEnv, invokeCli }) => {
    const sentinel = `session-start-${Date.now()}-${randomBytes(16).toString('hex')}`;
    const goal = `goal-${sentinel}`;
    const next = `next-${sentinel}`;
    mustSucceed(invokeCli(['remember', sentinel, '--tags', `project:${project}`, '--json']), 'session-start seed');
    const task = json(mustSucceed(invokeCli([
      'task', '--project', project, '--goal', goal, '--next', next, '--json',
    ]), 'task state write'), 'task state write');
    if (task.state?.goal !== goal || task.state?.next !== next) throw new Error('task state write did not read back exact values');

    // issue #412: `isolatedEnv` carries no MEMESH_BRIEFING override, so this
    // is what a real install actually gets — the default level (`minimal`).
    // A goal/next is `standard`+-only content (briefing-level.ts POLICIES);
    // the remembered sentinel is not level-gated at all. Asserting BOTH —
    // goal absent, sentinel present — at the level every fresh install ships
    // with is the point: `tests/core/briefing.test.ts` already covers this
    // at the unit/subprocess layer, but nothing at the journey layer (real
    // CLI + real SessionStart hook, glued together) exercised the default
    // before this fix; only `standard` was ever run here.
    const defaultBriefing = json(
      mustSucceed(invokeCli(['briefing', '--project', project, '--json']), 'default-level briefing readback'),
      'default-level briefing readback',
    );
    if (defaultBriefing.level !== 'minimal') throw new Error(`briefing ran at unexpected default level: ${defaultBriefing.level}`);
    if (defaultBriefing.text?.includes(goal) || defaultBriefing.text?.includes(next)) {
      throw new Error('CLI briefing included task state at the default (minimal) level, which must omit it');
    }
    if (!defaultBriefing.text?.includes(sentinel)) {
      throw new Error('CLI briefing omitted the remembered sentinel at the default (minimal) level');
    }
    const hook = path.join(repoRoot, 'scripts/hooks/session-start.js');
    const good = mustSucceed(runNode(hook, { cwd: repoRoot, env: isolatedEnv, input: JSON.stringify({ cwd: repoRoot, source: 'startup' }) }), 'SessionStart');
    const output = json(good, 'SessionStart');
    const additionalContext = output.hookSpecificOutput?.additionalContext;
    if (!additionalContext?.includes(sentinel)) {
      throw new Error('SessionStart did not inject the recalled memory at the default (minimal) level');
    }
    if (additionalContext.includes(goal) || additionalContext.includes(next)) {
      throw new Error('SessionStart injected task state at the default (minimal) level, which must omit it');
    }

    // Separately, confirm the `standard` override itself still works
    // end-to-end (not just at the unit layer): the same stated goal, read
    // through the same CLI AND the same SessionStart hook (a distinct
    // implementation — scripts/hooks/_shared.js resolves the level on its
    // own), WITH the override this journey used to always set
    // unconditionally.
    const standardEnv = { ...isolatedEnv, MEMESH_BRIEFING: 'standard' };
    const standardResult = cli({ args: ['briefing', '--project', project, '--json'], env: standardEnv, cwd: repoRoot });
    const standard = json(mustSucceed(standardResult, 'standard-level briefing readback'), 'standard-level briefing readback');
    if (standard.level !== 'standard') throw new Error(`MEMESH_BRIEFING=standard override did not produce standard level: ${standard.level}`);
    if (!standard.text?.includes(goal) || !standard.text?.includes(next)) {
      throw new Error('CLI briefing omitted stated task state at the standard level');
    }
    const standardHook = mustSucceed(runNode(hook, { cwd: repoRoot, env: standardEnv, input: JSON.stringify({ cwd: repoRoot, source: 'startup' }) }), 'SessionStart standard-level override');
    const standardAdditionalContext = json(standardHook, 'SessionStart standard-level override').hookSpecificOutput?.additionalContext;
    if (!standardAdditionalContext?.includes(goal) || !standardAdditionalContext.includes(next)) {
      throw new Error('SessionStart did not inject task state under the standard-level override');
    }

    const blocker = path.join(journeyDir, 'not-a-directory');
    fs.writeFileSync(blocker, 'blocks database parent creation');
    const bad = mustSucceed(runNode(hook, {
      cwd: repoRoot,
      env: { ...isolatedEnv, MEMESH_DB_PATH: path.join(blocker, 'knowledge-graph.db') },
      input: JSON.stringify({ cwd: repoRoot, source: 'startup' }),
    }), 'SessionStart unwritable DB');
    const failure = json(bad, 'SessionStart unwritable DB');
    if (!failure.systemMessage?.includes('memories will NOT be saved this session')) {
      throw new Error(`SessionStart did not surface database failure banner: ${JSON.stringify(failure)}`);
    }
    return result(
      'session-start-briefing',
      { observed: true, operations: ['task_state', 'briefing', 'SessionStart'] },
      { observed: true, databaseFailureBanner: true },
      { observed: true, taskStateReadback: true, cliBriefing: true, hookSpecificOutput: true, defaultLevelExcludesTaskState: true, standardLevelOverrideStillWorks: true },
    );
  })));

  evidence.push(await step('quiet-commit-capture', () => isolatedJourney('quiet-commit-capture', async ({ journeyDir, memeshDir, isolatedEnv, invokeCli }) => {
    const repo = assertInside(journeyDir, path.join(journeyDir, 'commit-repo'));
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main'], isolatedEnv);
    git(repo, ['config', 'user.email', 'journey@example.invalid'], isolatedEnv);
    git(repo, ['config', 'user.name', 'Core Journey'], isolatedEnv);
    git(repo, ['config', 'commit.gpgsign', 'false'], isolatedEnv);
    const hook = path.join(repoRoot, 'scripts/hooks/post-commit.js');
    const hash = commit(repo, 'fix: capture first quiet live journey commit', isolatedEnv, true);
    mustSucceed(runNode(hook, { cwd: repoRoot, env: isolatedEnv, input: JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git commit -q -m quiet >commit.log' }, tool_response: { stdout: '', stderr: '', isError: false } }) }), 'post-commit quiet commit');
    const captured = mustSucceed(invokeCli(['recall', hash, '--json']), 'captured commit recall');
    if (!json(captured, 'captured commit recall').entities?.some((entity) => entity.name === `commit-${hash}`)) throw new Error('quiet commit entity absent from recall');
    const before = outcomeRows(memeshDir, 'post-commit').length;
    mustSucceed(runNode(hook, { cwd: repoRoot, env: isolatedEnv, input: JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git commit -q -m failed' }, tool_response: { stdout: '', stderr: 'nothing to commit', isError: true } }) }), 'post-commit unchanged HEAD');
    const rows = outcomeRows(memeshDir, 'post-commit');
    if (rows.length !== before + 1 || rows.at(-1)?.reason !== 'a commit-like command completed but repository HEAD did not change') throw new Error('unchanged HEAD did not record its explicit skip');
    return result('quiet-commit-capture', { observed: true, quietCommit: hash }, { observed: true, unchangedHeadSkip: rows.at(-1)?.reason }, { observed: true, recalledCommit: `commit-${hash}` });
  })));

  evidence.push(await step('stop-session-insight', () => isolatedJourney('stop-session-insight', async ({ journeyDir, memeshDir, isolatedEnv, invokeCli }) => {
    const sentinel = `stop-${Date.now()}-${randomBytes(16).toString('hex')}`;
    const transcript = assertInside(journeyDir, path.join(journeyDir, 'transcript.jsonl'));
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Write', input: { file_path: path.join(repoRoot, 'journey.ts') } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- core-live-sentinel' } },
        { type: 'tool_use', name: 'Read', input: { file_path: path.join(repoRoot, 'README.md') } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: `controlled session failure ${sentinel}` }] } }),
    ].join('\n'));
    const hook = path.join(repoRoot, 'scripts/hooks/session-summary.js');
    const payload = { session_id: `core-${sentinel}`, cwd: repoRoot, was_in_agentic_loop: true, transcript_path: transcript };
    mustSucceed(runNode(hook, { cwd: repoRoot, env: isolatedEnv, input: JSON.stringify(payload) }), 'session-summary');
    const recalled = mustSucceed(invokeCli(['recall', 'Session summary', '--json']), 'session summary recall');
    if (!json(recalled, 'session summary recall').entities?.some((entity) => entity.type === 'session-insight')) throw new Error('session summary did not create a recallable insight');
    const specific = json(mustSucceed(invokeCli(['recall', sentinel, '--json']), 'specific session insight recall'), 'specific session insight recall');
    if (!specific.entities?.some(entity => entity.observations?.some(observation => observation.includes(`controlled session failure ${sentinel}`)))) {
      throw new Error('session insight lost the transcript-specific failure observation');
    }
    const before = outcomeRows(memeshDir, 'session-summary').length;
    mustSucceed(runNode(hook, { cwd: repoRoot, env: isolatedEnv, input: JSON.stringify({ ...payload, session_id: `missing-${sentinel}`, transcript_path: path.join(journeyDir, 'missing.jsonl') }) }), 'session-summary missing transcript');
    const rows = outcomeRows(memeshDir, 'session-summary');
    if (rows.length !== before + 1 || rows.at(-1)?.reason !== 'the transcript file named by the payload is gone') throw new Error('missing transcript did not record its explicit skip');
    return result('stop-session-insight', { observed: true, transcriptCaptured: true }, { observed: true, missingTranscriptSkip: rows.at(-1)?.reason }, { observed: true, insightRecalled: true, sentinel });
  })));

  return { schema: 'memesh-core-live-journeys/v1', runDir: resolvedRunDir, journeys: evidence };
}
