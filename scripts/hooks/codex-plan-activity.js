#!/usr/bin/env node
import { realpathSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, getMemeshDirFromDbPath, hookErrorReason, hookMessageSessionId, isCodexHost, recordHookOutcome, writePrivateJson } from './_shared.js';
import { pruneSessionState } from './_stop-notes.js';
import { isValidCodexThreadId } from './_generated/codex-session-principal.js';

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
    if (!isCodexHost(process.env) || data.hook_event_name !== 'PostToolUse' || data.tool_name !== 'update_plan' || !isValidCodexThreadId(data.session_id) || hookMessageSessionId(data.session_id).mismatch) { record('skipped', 'not a valid Codex plan event'); return; }
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
    record('skipped', valid ? 'activity state recorded; no notification' : 'invalid or failed plan cleared');
  } catch (error) { record('error', hookErrorReason(error)); }
});
