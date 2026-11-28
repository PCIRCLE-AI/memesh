#!/usr/bin/env node
import { lstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, getDbPath, getMemeshDirFromDbPath, getProjectName, hookErrorReason, hookMessageSessionId, isAutoCaptureEnabled, isCodexHost, openMemeshDb, parseTaskState, recordHookOutcome, SKIP_REASONS, taskStateName, writePrivateJson, writePrivateJsonAtomic } from './_shared.js';
import { pruneSessionState } from './_stop-notes.js';
import { isValidCodexThreadId } from './_generated/codex-session-principal.js';
import { continuationTaskKey, continuationWrite, pruneContinuation } from './_generated/continuation.js';

function privateActivityDirectory(directory) {
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw new Error('activity state is not a directory');
  ensurePrivateDir(directory);
}

function currentTaskKey(project) {
  try {
    const db = openMemeshDb(getDbPath(), { readOnly: true });
    try {
      const row = db.prepare("SELECT metadata FROM entities WHERE name = ? AND status = 'active'").get(taskStateName(project));
      return row?.metadata ? continuationTaskKey(parseTaskState(JSON.parse(row.metadata))) : undefined;
    } finally { db.close(); }
  } catch { return undefined; }
}

let input = '';
let inputBytes = 0;
const MAX_INPUT_BYTES = 1024 * 1024;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { inputBytes += Buffer.byteLength(chunk); if (inputBytes <= MAX_INPUT_BYTES) input += chunk; });
process.stdin.on('end', () => {
  let data;
  const record = (outcome, reason) => recordHookOutcome(process.env, { hook: 'codex-plan-activity', outcome, reason, payload: data });
  try {
    if (inputBytes > MAX_INPUT_BYTES) {
      const thread = process.env.CODEX_THREAD_ID;
      if (isCodexHost(process.env) && isValidCodexThreadId(thread)) {
        try { unlinkSync(join(getMemeshDirFromDbPath(), 'codex-plan-activity', `${thread}.json`)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      record('error', 'input exceeds 1 MiB'); return;
    }
    data = JSON.parse(input);
    if (data.tool_name === 'Bash' && ['PreToolUse', 'PostToolUse'].includes(data.hook_event_name)) {
      if (!isCodexHost(process.env) || !isValidCodexThreadId(data.session_id) || hookMessageSessionId(data.session_id).mismatch
        || typeof data.cwd !== 'string' || typeof data.turn_id !== 'string' || typeof data.tool_use_id !== 'string'
        || (data.tool_cwd !== undefined && data.tool_cwd !== data.cwd)
        || (data.tool_input?.workdir !== undefined && data.tool_input.workdir !== data.cwd)
        || typeof data.tool_input?.command !== 'string') return;
      if (!isAutoCaptureEnabled()) { record('skipped', SKIP_REASONS.autoCaptureOff); return; }
      const project = getProjectName(data.cwd);
      const returned = data.hook_event_name === 'PostToolUse';
      const task = returned ? undefined : currentTaskKey(project);
      const operation = continuationWrite(project, data.cwd, data.session_id, data.turn_id, data.tool_use_id, returned, task);
      if (operation) {
        privateActivityDirectory(join(getMemeshDirFromDbPath(), 'codex-plan-activity'));
        privateActivityDirectory(operation.directory);
        writePrivateJsonAtomic(operation.file, operation.record);
        if (operation.record.returned !== undefined) pruneContinuation(operation.directory, operation.file, operation.record.since);
        record('wrote', 'bounded shell activity');
      }
      return;
    }
    if (!isCodexHost(process.env) || data.hook_event_name !== 'PostToolUse' || data.tool_name !== 'update_plan' || !isValidCodexThreadId(data.session_id) || hookMessageSessionId(data.session_id).mismatch) { record('skipped', SKIP_REASONS.notCodexPlanEvent); return; }
    const workspace = realpathSync(data.cwd);
    const plan = data.tool_input?.plan;
    const valid = !data.tool_response?.isError && Array.isArray(plan) && plan.every(item => typeof item?.step === 'string' && ['pending', 'in_progress', 'completed'].includes(item.status)) && plan.filter(item => item.status === 'in_progress').length <= 1;
    const task = valid ? plan.find(item => item.status === 'in_progress')?.step.trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/, '') : undefined;
    const dir = join(getMemeshDirFromDbPath(), 'codex-plan-activity');
    ensurePrivateDir(dir);
    pruneSessionState(dir, Date.now());
    const file = join(dir, `${data.session_id}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    writePrivateJson(temp, { session: data.session_id, workspace, ...(task ? { task } : {}) });
    renameSync(temp, file);
    record('skipped', valid ? SKIP_REASONS.planActivityRecorded : SKIP_REASONS.planActivityCleared);
  } catch (error) { record('error', hookErrorReason(error)); }
});
