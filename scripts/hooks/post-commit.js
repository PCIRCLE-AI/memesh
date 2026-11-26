#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { chmodSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { MemeshDatabase } from './_generated/sqlite.js';
import { isAbsolute, join, resolve } from 'path';
import { AUTO_CAPTURE_TAG, SKIP_REASONS, captureEntity, ensurePrivateDir, getMemeshDirFromDbPath, getProjectName, isAutoCaptureEnabled, isGitCommitCommand, openHookDb, hookErrorReason, hookCaughtReason, hookSourceHost, recordHookOutcome, recordHookRun, redactSecrets, truncateTitle } from './_shared.js';

const HEAD_MARKER_DIR = 'post-commit-heads';
const FULL_SHA = /^[a-f0-9]{40,64}$/;
const MAX_COMMITS_PER_RUN = 20;
// Leave time to record an error before the host's five-second hook deadline.
const MARKER_LOCK_TIMEOUT_MS = 1000;

function gitText(cwd, args, maxBuffer = 1024 * 1024) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function validStoredHeads(parsed) {
  const heads = {};
  if (parsed?.heads && typeof parsed.heads === 'object') {
    for (const [key, head] of Object.entries(parsed.heads)) {
      if (/^[a-f0-9]{64}$/.test(key) && typeof head === 'string' && FULL_SHA.test(head)) heads[key] = head;
    }
  }
  return heads;
}

function validStoredFailures(parsed) {
  return Object.fromEntries(Object.entries(parsed?.failures ?? {}).filter(([hash, count]) =>
    FULL_SHA.test(hash) && Number.isInteger(count) && count >= 1 && count <= 3));
}

function closestKnownAncestor(cwd, head, candidates) {
  let closest = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of new Set(candidates)) {
    if (!FULL_SHA.test(candidate)) continue;
    try {
      execFileSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', candidate, head], {
        timeout: 5000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const count = Number.parseInt(gitText(cwd, ['rev-list', '--count', `${candidate}..${head}`]), 10);
      if (Number.isFinite(count) && count < distance) {
        closest = candidate;
        distance = count;
      }
    } catch {}
  }
  return closest;
}

/** Resolve one repository's current HEAD and its privacy-preserving per-worktree state. */
function resolveHeadLocation(cwd) {
  const rawCommonDir = gitText(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = realpathSync(isAbsolute(rawCommonDir) ? rawCommonDir : resolve(cwd, rawCommonDir));
  const rawGitDir = gitText(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const gitDir = realpathSync(isAbsolute(rawGitDir) ? rawGitDir : resolve(cwd, rawGitDir));
  const key = createHash('sha256').update(commonDir).digest('hex');
  const worktreeKey = createHash('sha256').update(gitDir).digest('hex');
  const markerDir = join(getMemeshDirFromDbPath(), HEAD_MARKER_DIR);
  const markerPath = join(markerDir, `${key}.json`);
  return { markerDir, markerPath, worktreeKey };
}

function resolveHeadState(cwd, location) {
  const head = gitText(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (!FULL_SHA.test(head)) throw new Error('git returned an invalid HEAD');
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(location.markerPath, 'utf8'));
  } catch {
    // Missing or malformed state is the same safe boundary: establish a
    // baseline and never guess which existing commits belonged to this run.
  }
  const heads = validStoredHeads(parsed);
  const legacyHead = typeof parsed?.head === 'string' && FULL_SHA.test(parsed.head) ? parsed.head : null;
  // A stored worktree position can stop being an ancestor after reset or
  // rebase. Re-prove ancestry every time, then fall back only to another
  // known position Git proves is on the current history.
  const previous = closestKnownAncestor(cwd, head, [
    ...(heads[location.worktreeKey] ? [heads[location.worktreeKey]] : []),
    ...Object.values(heads),
    ...(legacyHead ? [legacyHead] : []),
  ]);
  const short = gitText(cwd, ['rev-parse', '--short', head]);
  let branch = 'unknown';
  try { branch = gitText(cwd, ['branch', '--show-current']) || 'detached'; } catch {}
  return { head, previous, short, branch, failures: validStoredFailures(parsed), ...location };
}

function acquireMarkerLock(markerPath) {
  // Keep one stable file: SQLite releases its OS lock on close or process death.
  // Never unlink/rename it; pathname-based stale recovery can steal a new owner.
  // This is separate from the graph so a baseline need not create user memories.
  const db = new MemeshDatabase(`${markerPath}.lock.sqlite`);
  try {
    db.pragma(`busy_timeout = ${MARKER_LOCK_TIMEOUT_MS}`);
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    db.close();
    if (err?.errcode === 5 || err?.code === 'SQLITE_BUSY') {
      throw new Error('timed out waiting for post-commit state lock', { cause: err });
    }
    throw err;
  }
  return () => db.close();
}

/** Advance only this worktree's position. The caller holds the repository marker lock. */
function writeHeadState(state, advance = true) {
  ensurePrivateDir(state.markerDir);
  const tmp = `${state.markerPath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    let heads = {};
    try { heads = validStoredHeads(JSON.parse(readFileSync(state.markerPath, 'utf8'))); } catch {}
    if (advance) heads[state.worktreeKey] = state.head;
    else if (!heads[state.worktreeKey] && FULL_SHA.test(state.previous ?? '')) heads[state.worktreeKey] = state.previous;
    writeFileSync(tmp, JSON.stringify({ version: 2, heads, failures: state.failures }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, state.markerPath);
    try { chmodSync(state.markerPath, 0o600); } catch {}
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function commitsFromState(cwd, state, db) {
  const raw = gitText(cwd, [
    'log', '--reverse', '--format=%H %h', `${state.previous}..${state.head}`,
  ], 64 * 1024 * 1024);
  const range = raw ? raw.split('\n').map((line) => {
    const [fullHash, hash] = line.split(' ');
    if (!FULL_SHA.test(fullHash) || !/^[a-f0-9]{4,64}$/.test(hash)) throw new Error('git returned an invalid commit range');
    return { fullHash, hash };
  }) : [];
  // Names in any state count, including archived memories. One bound JSON
  // parameter also avoids SQLite's variable limit for a large backlog.
  const stored = new Set(db.prepare('SELECT name FROM entities WHERE name IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(range.map(({ hash }) => `commit-${hash}`))).map(row => row.name));
  const pending = range.filter(({ fullHash, hash }) => !stored.has(`commit-${hash}`) && state.failures[fullHash] !== 3);
  return {
    commits: pending.slice(0, MAX_COMMITS_PER_RUN).map(({ fullHash, hash }) => ({
      fullHash, hash,
      branch: state.branch,
      batch: range.length > 1,
    })),
    pending: pending.length,
  };
}

function captureCommit(db, data, projectName, commit) {
  const entityName = `commit-${commit.hash}`;
  const observations = [commit.message, `Branch: ${commit.branch}`];
  try {
    const stat = gitText(data.cwd, ['show', '--stat', '--format=', commit.hash]);
    if (stat) {
      const statLines = stat.split('\n').filter((line) => line.trim());
      const summary = statLines[statLines.length - 1]?.trim() || '';
      if (summary) observations.push(`Diff stats: ${summary}`);
    }
  } catch {
    // Diff stats are best-effort and never decide whether the commit exists.
  }

  const whyMetadata = {};
  if (typeof data.session_id === 'string' && data.session_id) whyMetadata.session_id = data.session_id;
  try {
    const nameOnly = gitText(data.cwd, ['show', '--name-only', '--format=', commit.hash]);
    if (nameOnly) {
      const files = nameOnly.split('\n').map((line) => line.trim()).filter(Boolean);
      if (files.length > 0) whyMetadata.files = files.slice(0, 50);
    }
  } catch {
    // File names are best-effort metadata, like diff stats.
  }

  const written = captureEntity(db, {
    name: entityName,
    type: 'commit',
    observations,
    tags: [AUTO_CAPTURE_TAG, `project:${projectName}`, ...(commit.batch ? ['origin:batch'] : [])],
    // #523: redact BEFORE the 200-character cut. `captureEntity` redacts
    // again, but a secret already cut in half no longer matches its pattern.
    title: truncateTitle(redactSecrets(commit.message)),
    metadata: whyMetadata,
    sourceHost: hookSourceHost(data, process.env),
  });
  return { entityName, written };
}

// The parsed payload, hoisted so the outcome recorder below can read
// session_id and the host signal from ANY exit path — including the ones
// that fire before or instead of a capture.
let payload = null;
let releaseStateLock = null;

/**
 * Leave a record on this exit path (issue #327).
 *
 * Every `return exit0()` below is a decision this hook made about a real
 * event, and until now every one of them was indistinguishable from the hook
 * not running at all. That is exactly how #321 hid: `git commit -q` prints no
 * line, so `no commit line in output` fired on every commit for two days and
 * the graph looked identical to a hook broken by an upgrade.
 */
function record(outcome, reason, entity, count) {
  recordHookOutcome(process.env, { hook: 'post-commit', outcome, reason, entity, count, payload });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // Opt-out check (env > config > default-on). This hook skipped it for
    // years while its two siblings honoured it — with capture disabled it
    // kept writing commit entities AND stamping the heartbeat, which made
    // doctor's "capture is off, hook silence is expected" message false.
    if (!isAutoCaptureEnabled(process.env)) {
      record('skipped', SKIP_REASONS.autoCaptureOff);
      return exit0();
    }

    const data = JSON.parse(input);
    payload = data;

    // tool_name absent is a schema-flip signal (Claude Code has done
    // tool_name renames historically — e.g. tool_use/tool_result
    // nesting). Trace to surface the rename day-1 instead of months
    // of silent dropout (the bug shape that bit `tool_output` and
    // `was_in_agentic_loop`).
    if (data.tool_name === undefined) {
      try { process.stderr.write(`[memesh post-commit] tool_name absent in payload (keys: ${Object.keys(data).join(',')}); skipping\n`); } catch {}
      record('skipped', SKIP_REASONS.toolNameAbsent);
      return exit0();
    }
    if (data.tool_name !== 'Bash') {
      record('skipped', SKIP_REASONS.notBash);
      return exit0();
    }

    // The COMMAND decides whether this run is about a commit at all, and it
    // is checked BEFORE the output for two reasons.
    //
    // First, the output looking like a commit is not evidence that a commit
    // happened. This hook once stopped at the output regex below, so any Bash
    // output containing a commit-shaped line produced a permanent memory.
    // Measured: a payload whose command was `cat docs/release-notes.md` wrote
    // entity `commit-9f3c2a1` for a hash `git cat-file -t` rejects as "Not a
    // valid object name".
    //
    // Second, the two skips mean opposite things to `memesh doctor` (#327):
    // "not a git commit command" is this hook correctly ignoring `ls`, on
    // almost every Bash call, and must not count as silence; "a git commit
    // ran but printed no commit line" is the #321 shape — a commit happened
    // and nothing was saved — and is exactly the silence worth a sentence.
    const issuedCommand = typeof data.tool_input?.command === 'string' ? data.tool_input.command : '';
    if (!isGitCommitCommand(issuedCommand)) {
      record('skipped', SKIP_REASONS.notGitCommit);
      return exit0();
    }

    if (!data.cwd) {
      try { process.stderr.write('[memesh post-commit] data.cwd absent — cannot resolve project / repo; skipping\n'); } catch {}
      record('skipped', SKIP_REASONS.commitCwdAbsent);
      return exit0();
    }

    // Current PostToolUse payloads explicitly say whether the command failed.
    // Legacy payloads expose only terminal text. That text may corroborate a
    // successfully resolved HEAD, but it is never commit authority by itself:
    // wrappers can replay buffered output, while `-q` can hide a real commit.
    const tr = data.tool_response;
    let toolOutput = '';
    if (typeof tr === 'string') toolOutput = tr;
    else if (tr && typeof tr === 'object') {
      const stdout = typeof tr.stdout === 'string' ? tr.stdout : '';
      const stderr = typeof tr.stderr === 'string' ? tr.stderr : '';
      toolOutput = stdout + (stderr ? `\n${stderr}` : '');
    } else if (typeof data.tool_output === 'string') toolOutput = data.tool_output;
    else if (data.tool_output != null) toolOutput = JSON.stringify(data.tool_output);
    const commitMatch = toolOutput.match(/\[[\w/.-]+(?: \([\w -]+\))? ([a-f0-9]{7,})\] (.+)/);
    let state = null;
    let location = null;
    try { location = resolveHeadLocation(data.cwd); } catch {}
    if (location) {
      ensurePrivateDir(location.markerDir);
      releaseStateLock = acquireMarkerLock(location.markerPath);
      try { state = resolveHeadState(data.cwd, location); } catch {}
    }

    let branch;
    let commitHash;
    let commitMsg;
    if (state?.previous && state.previous !== state.head) {
      branch = state.branch;
      commitHash = state.short;
    } else if (state && state.previous === state.head) {
      // When Git state is available it is stronger evidence than terminal
      // text. A failed command can return buffered or wrapper-produced text
      // that looks like an earlier commit; unchanged HEAD must never turn
      // that stale text into a write or a false liveness heartbeat.
      try { process.stderr.write('[memesh post-commit] commit-like command completed, but repository HEAD did not change\n'); } catch {}
      record('skipped', SKIP_REASONS.commitHeadUnchanged);
      return exit0();
    } else if (!state) {
      try { process.stderr.write('[memesh post-commit] commit-like command ran, but repository HEAD could not be resolved\n'); } catch {}
      record('skipped', SKIP_REASONS.commitHeadUnresolvable);
      return exit0();
    } else if (state.previous === null
      && tr?.isError !== true && tr?.interrupted !== true
      && commitMatch
      && state.head.startsWith(commitMatch[1])) {
      // Success flags are optional across hosts. Accept the commit line only
      // after Git independently proves that exact hash is HEAD, and never
      // when the host explicitly reports failure or interruption.
      branch = state.branch;
      commitHash = state.short;
      commitMsg = gitText(data.cwd, ['show', '-s', '--format=%s', state.head]);
    } else if (state.previous === null && tr && typeof tr === 'object' && tr.isError === false && tr.interrupted !== true) {
      // A current Claude Code PostToolUse payload tells us the command
      // completed successfully.  In that one case HEAD itself is the newly
      // created commit, even when `-q` or redirection removed every output
      // line.  Capture only HEAD: older repository history remains outside
      // this event and is never backfilled.
      branch = state.branch;
      commitHash = state.short;
      commitMsg = gitText(data.cwd, ['show', '-s', '--format=%s', state.head]);
    } else if (state.previous === null) {
      writeHeadState(state);
      try { process.stderr.write('[memesh post-commit] recorded repository HEAD baseline; existing history was not backfilled\n'); } catch {}
      record('skipped', SKIP_REASONS.commitHeadBaseline);
      return exit0();
    }
    // And the commit has to actually be in THIS repository.
    //
    // `cat-file -e <hash>^{commit}` answers exactly one question — does this
    // resolve to a commit object here — in milliseconds, before anything is
    // written. Deliberately separate from the `git show` below, whose failure
    // (git absent, timeout on a huge diff) says nothing about the commit and
    // must NOT veto.
    try {
      execFileSync('git', ['-C', data.cwd, 'cat-file', '-e', `${commitHash}^{commit}`], {
        timeout: 5000,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      try { process.stderr.write(`[memesh post-commit] ${commitHash} is not a commit in ${data.cwd}; nothing written\n`); } catch {}
      record('skipped', SKIP_REASONS.hashNotACommit);
      return exit0();
    }

    const projectName = getProjectName(data.cwd);

    if (state.previous === null) {
      // Persist the event's baseline before opening the graph. A graph lock
      // must not erase this newly observed commit on the next invocation.
      let parent;
      try { parent = gitText(data.cwd, ['rev-parse', '--verify', `${state.head}^`]); } catch {}
      if (parent && FULL_SHA.test(parent)) {
        writeHeadState({ ...state, head: parent });
        state.previous = parent;
      }
      // A repository's root commit has no parent; retain the existing boundary.
    }

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // Pass fts:true so the FTS5 entity-search index is also available.
    const { db } = openHookDb(process.env, { fts: true });
    try {
      const resolved = state.previous
        ? commitsFromState(data.cwd, state, db)
        : { commits: [{ fullHash: state.head, hash: commitHash, message: commitMsg, branch, batch: false }], pending: 1 };
      const commits = resolved.commits;
      let remaining = resolved.pending;
      const captured = [];
      let archivedCount = 0;
      for (const pendingCommit of commits) {
        // Keep subject lookup outside the write-failure catch: a Git error is
        // still a hook error, rather than a three-strike capture failure.
        const commit = pendingCommit.message === undefined
          ? { ...pendingCommit, message: gitText(data.cwd, ['show', '-s', '--format=%s', pendingCommit.fullHash]) }
          : pendingCommit;
        let result;
        try {
          result = captureCommit(db, data, projectName, commit);
          if (!result.written) throw new Error('captureEntity did not land the write');
        } catch (err) {
          record('error', hookErrorReason(err));
          if (hookCaughtReason(err) === 'MEMESH_DB_LOCKED') break;
          const count = Math.min(3, (state.failures[commit.fullHash] ?? 0) + 1);
          state.failures[commit.fullHash] = count;
          writeHeadState(state, false);
          if (count === 3) {
            remaining--;
            record('skipped', SKIP_REASONS.commitsNotStoredWriteFailed, undefined, 1);
          }
          continue;
        }
        delete state.failures[commit.fullHash];
        remaining--;
        if (result.written.archived) {
          archivedCount++;
          continue;
        }
        captured.push(result.entityName);
      }

      // One hook invocation is one heartbeat even when a merge exposes a
      // bounded batch. Advance the state only after every selected commit
      // landed or was deliberately skipped, so failures can still retry.
      writeHeadState(state, remaining === 0);
      if (resolved.pending === 0) record('skipped', SKIP_REASONS.commitsAlreadyProcessed);
      if (remaining > 0) record('skipped', SKIP_REASONS.commitsLeftForNextRun, undefined, remaining);
      if (captured.length === 0 && archivedCount > 0) {
        record('skipped', SKIP_REASONS.captureTargetArchived, `commit-${commitHash}`);
        return exit0();
      }
      if (captured.length === 0) return exit0();
      recordHookRun(db, 'post-commit');
      const reason = captured.length > 1 || archivedCount > 0
        ? `captured ${captured.length} commits as a batch` + (archivedCount ? `; ${archivedCount} archived commits left unchanged` : '')
        : undefined;
      record('wrote', reason, captured.at(-1));
    } finally {
      db.close();
    }
  } catch (err) {
    // Never crash Claude Code — but leave a trace for debugging
    try { process.stderr.write(`[memesh post-commit] ${err?.message || err}\n`); } catch {}
    record('error', hookErrorReason(err));
  }
  // Emit NOTHING on success — not `{"suppressOutput": true}`.
  //
  // That field is valid Claude Code hook output, and it was doing no work:
  // this hook writes nothing else to stdout, so there was never any output
  // to suppress. But Codex CLI validates hook output per event against its
  // own schema, and rejects the field on PostToolUse — reported from a live
  // Codex session as "PostToolUse hook returned unsupported suppressOutput",
  // once per Bash tool call, with the capture itself having already succeeded.
  //
  // Empty stdout with exit 0 is the "no opinion" signal in BOTH contracts,
  // and it is what `validateHookOutput` already classifies as `kind: 'empty'`.
  // So the portable answer is silence, and the field's only remaining effect
  // was to fail one host for no benefit on the other.
  exit0();
});

function exit0() {
  if (releaseStateLock) {
    const release = releaseStateLock;
    releaseStateLock = null;
    try { release(); } catch {}
  }
  process.exit(0);
}
