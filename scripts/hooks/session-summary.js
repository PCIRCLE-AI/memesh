#!/usr/bin/env node

import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { hostname } from 'os';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'fs';
import {
  AUTO_CAPTURE_TAG,
  captureConversation,
  extractCitedMemoryIds,
  recallSessionPath,
  writePrivateJsonAtomic,
  openWindowsHookState,
  prepareWindowsHookState,
  prepareWindowsSessionStateWrite,
  windowsHookStateDeadline,
  writeWindowsSessionState,
  getMemeshDirFromDbPath,
  getProjectName,
  isAutoCaptureEnabled,
  openHookDb,
  redactSecrets,
  hookErrorReason,
  hookSourceHost,
  recordHookOutcome,
  stampHookRunOnly,
  SKIP_REASONS,
} from './_shared.js';
import { runStopNotes } from './_stop-notes.js';
import { agentMessageTexts, omitAgentMessageText, lastAssistantText, HANDOFF_TRANSCRIPT_TAIL_BYTES } from './_generated/session-handoff.js';

function captureAssistantConversation(data, project) {
  if (!project || !data.session_id) return false;
  const transcript = typeof data.transcript_path === 'string' ? data.transcript_path : '';
  const transcriptExists = transcript && existsSync(transcript);
  let raw = data.last_assistant_message;
  const fromPayload = typeof raw === 'string' && raw.trim() !== '';
  let tail = '';
  if (transcriptExists) {
    try {
      const fd = openSync(transcript, 'r');
      try {
        const stat = fstatSync(fd);
        if (stat.isDirectory()) throw new Error('transcript_path is a directory');
        const start = Math.max(0, stat.size - HANDOFF_TRANSCRIPT_TAIL_BYTES);
        const bytes = Buffer.alloc(stat.size - start);
        let got = 0;
        while (got < bytes.length) {
          const n = readSync(fd, bytes, got, bytes.length - got, start + got);
          if (n === 0) break;
          got += n;
        }
        tail = bytes.subarray(0, got).toString('utf8');
      } finally { closeSync(fd); }
    } catch (err) {
      process.stderr.write('[memesh session-summary] unreadable transcript: ' + hookErrorReason(err) + '\n');
      if (!fromPayload) throw err;
      recordHookOutcome(process.env, { hook: 'session-summary', outcome: 'error', reason: `quoted agent messages not checked: ${hookErrorReason(err)}`, payload: data });
    }
  }
  if (!fromPayload) raw = lastAssistantText(tail);
  if (typeof raw !== 'string' || !raw.trim()) {
    record('skipped', transcriptExists ? SKIP_REASONS.noAssistantText
      : transcript ? SKIP_REASONS.transcriptGone : SKIP_REASONS.transcriptPathAbsent);
    return Boolean(transcript);
  }
  // Keep the complete reply, including short acknowledgements and code;
  // only quoted agent-message text is omitted before it becomes memory.
  const { texts } = agentMessageTexts(tail);
  const text = omitAgentMessageText(redactSecrets(raw), [...texts, ...texts.map(t => redactSecrets(t))]).text;
  const eventId = data.prompt_id ?? data.turn_id;
  const identity = typeof eventId === 'string' && eventId ? createHash('sha256').update(JSON.stringify([data.session_id, eventId, 'assistant'])).digest('hex') : randomUUID();
  const name = `conversation-${identity}`;
  const result = captureConversation({
    name, type: 'conversation', replace: true,
    title: text.split('\n').find(line => line.trim())?.trim().slice(0, 120),
    observations: [text],
    quoteSource: { session: data.session_id, machine: hostname().toLowerCase() },
    tags: [AUTO_CAPTURE_TAG, `project:${project}`, `session:${data.session_id}`, 'role:assistant'],
    sourceHost: hookSourceHost(data),
  });
  const reason = (result.reason ?? 'stored assistant conversation') + '; assistant text from ' + (fromPayload ? 'payload' : 'transcript');
  if (result.skipped) record('skipped', reason);
  else if (result.queued) record('error', reason);
  else record('wrote', reason, name);
  return !result.queued;
}
// Read marker text only from its native author. Reasoning, user prose and
// ordinary citations in tool output are not assistant-authored citations.
function usedMemoryIds(rawTranscript, injectedAt) {
  const used = new Set();
  let eligible = false;
  let candidateRows = 0;
  let timestampedCandidates = 0;
  function add(text, fetched = false) {
    if (typeof text !== 'string') return;
    if (fetched) {
      for (const match of text.matchAll(/\[mem-fetched:(\d{1,10})\]/g)) {
        const id = Number(match[1]);
        if (id > 0) used.add(id);
      }
    } else {
      for (const id of extractCitedMemoryIds(text)) used.add(id);
    }
  }
  function blocks(content, textType, fetched = false) {
    if (typeof content === 'string') add(content, fetched);
    else if (Array.isArray(content)) {
      for (const block of content) if (block?.type === textType) add(block.text, fetched);
    }
  }
  // Role selection already excludes hook attachments. Native Claude and
  // Codex rows both carry their timestamp at the JSONL record's root.
  for (const line of rawTranscript.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const claudeAssistant = entry?.type === 'assistant' && (!entry.message?.role || entry.message.role === 'assistant');
    const claudeTool = entry?.type === 'user' && Array.isArray(entry.message?.content)
      && entry.message.content.some(block => block?.type === 'tool_result');
    const item = entry?.type === 'response_item' ? entry.payload : null;
    const codexAssistant = item?.type === 'message' && item.role === 'assistant';
    const codexTool = item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output';
    if (!claudeAssistant && !claudeTool && !codexAssistant && !codexTool) continue;
    candidateRows++;
    const timestamp = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) continue;
    timestampedCandidates++;
    if (timestamp < injectedAt) continue;
    eligible = true;
    if (claudeAssistant) {
      blocks(entry.message?.content, 'text');
    } else if (claudeTool) {
      for (const block of entry.message.content) {
        if (block?.type === 'tool_result') {
          blocks(block.content, 'text', true);
        }
      }
    } else if (codexAssistant) {
      blocks(item.content, 'output_text');
    } else if (codexTool) {
      blocks(item.output, 'input_text', true);
    }
  }
  if (candidateRows > 0 && timestampedCandidates === 0) {
    const error = new Error('candidate transcript rows have no parseable root timestamp');
    error.name = 'TranscriptTimestampError';
    throw error;
  }
  return { used, eligible };
}

const ACCOUNTING_MODE = 'citation-or-fetch-v3 since 2026-11-01';

function accountRecallUse(sessionId, project, transcriptPath) {
  const filePath = recallSessionPath(join(getMemeshDirFromDbPath(), 'sessions'), sessionId, project);
  if (!filePath) {
    record('skipped', SKIP_REASONS.noSessionId);
    return;
  }
  const windowsState = process.platform === 'win32'
    ? prepareWindowsHookState(filePath, windowsHookStateDeadline(10000))
    : null;
  if (windowsState ? !windowsState.file : !existsSync(filePath)) {
    record('skipped', SKIP_REASONS.noRecallSessionRecord);
    return;
  }
  const fd = windowsState ? openWindowsHookState(windowsState, 'r') : openSync(filePath, 'r');
  let injection;
  try { injection = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
  if (injection.sessionId !== sessionId || injection.project !== project) {
    record('skipped', SKIP_REASONS.noRecallSessionRecord);
    return;
  }
  const entityIds = (injection.entityIds || []).filter(id => Number.isSafeInteger(id) && id > 0);
  const injectedAt = typeof injection.injectedAt === 'string' ? Date.parse(injection.injectedAt) : NaN;
  const { used, eligible } = usedMemoryIds(readFileSync(transcriptPath, 'utf8'), Number.isFinite(injectedAt) ? injectedAt : Infinity);
  if (!eligible) {
    // Keep a live record fresh even when the transcript has only old rows.
    // A rebuilt record must never replay the transcript before its injection.
    if (windowsState) writeWindowsSessionState(windowsState, injection);
    else writePrivateJsonAtomic(filePath, injection);
    record('skipped', SKIP_REASONS.noEligibleRecallRows);
    return;
  }
  const write = windowsState ? prepareWindowsSessionStateWrite(windowsState) : null;
  let db;
  try {
    ({ db } = openHookDb(process.env, { fts: true }));
    db.transaction(() => {
      const priorMode = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'recall_accounting_mode'").get()?.value;
      if (priorMode && priorMode !== ACCOUNTING_MODE) {
        const prior = key => db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key)?.value ?? 'absent';
        const total = prior('citation_sessions_total');
        const cited = prior('citation_sessions_cited');
        db.prepare("DELETE FROM memesh_metadata WHERE key IN ('citation_sessions_total', 'citation_sessions_cited')").run();
        try { process.stderr.write(`[memesh session-summary] citation accounting generation changed (${priorMode} -> ${ACCOUNTING_MODE}); counters reset from total=${total} cited=${cited} — the two eras count different things and are not comparable.\n`); } catch {}
      }
      // The global stamp may be rewritten by an older installed host. It is
      // not authority to discard credits this session already persisted.
      const current = injection.accountingMode === ACCOUNTING_MODE;
      const credited = new Set(current ? (injection.creditedIds || []) : []);
      const hadCredit = credited.size > 0;
      const updateHit = db.prepare('UPDATE entities SET recall_hits = COALESCE(recall_hits, 0) + 1 WHERE id = ?');
      for (const id of entityIds) {
        if (used.has(id) && !credited.has(id)) {
          updateHit.run(id);
          credited.add(id);
        }
      }
      db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run('recall_accounting_mode', ACCOUNTING_MODE);
      const bump = db.prepare(`INSERT INTO memesh_metadata (key, value) VALUES (?, '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
      // Absent counters must remain distinguishable from measured zero use.
      for (const key of ['citation_sessions_total', 'citation_sessions_cited']) {
        db.prepare("INSERT INTO memesh_metadata (key, value) VALUES (?, '0') ON CONFLICT(key) DO NOTHING").run(key);
      }
      if (!(current && injection.sessionCounted)) bump.run('citation_sessions_total');
      if (!hadCredit && credited.size > 0) bump.run('citation_sessions_cited');
      const next = { ...injection, accountingMode: ACCOUNTING_MODE, creditedIds: [...credited], sessionCounted: true };
      if (write) write.publish(next);
      else writePrivateJsonAtomic(filePath, next);
    })();
  } finally {
    try { db?.close(); } finally { write?.discard(); }
  }
}

// Stop captures the raw reply and imports notes. Keep stdout empty for both hosts.
let input = '';
let payload;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });

function record(outcome, reason, entity) {
  recordHookOutcome(process.env, { hook: 'session-summary', outcome, reason, entity, payload });
}

process.stdin.on('end', async () => {
  if (!input.trim()) {
    record('skipped', SKIP_REASONS.emptyStdin);
    return;
  }
  try {
    payload = JSON.parse(input);
  } catch {
    process.stderr.write('[memesh session-summary] malformed stdin JSON\n');
    record('error', 'malformed stdin JSON');
    return;
  }

  try {
    const captureEnabled = isAutoCaptureEnabled(process.env);
    const project = payload.cwd ? getProjectName(payload.cwd) : undefined;
    let captureHealthy = false;
    if (captureEnabled) {
      try { captureHealthy = captureAssistantConversation(payload, project); }
      catch (err) {
        process.stderr.write('[memesh session-summary] could not open or write conversation capture: ' + (err?.message || err) + '\n');
        record('error', hookErrorReason(err));
      }
    }
    await runStopNotes(payload, { captureEnabled, project, metaUrl: import.meta.url });

    if (!captureEnabled) {
      record('skipped', SKIP_REASONS.autoCaptureOff);
      return;
    }
    if (!payload.cwd) {
      process.stderr.write('[memesh session-summary] cwd absent in payload; cannot resolve project, skipping capture\n');
      record('skipped', SKIP_REASONS.cwdAbsent);
      return;
    }
    if (!payload.session_id) {
      record('skipped', SKIP_REASONS.noSessionId);
      return;
    }

    // Citation accounting still uses the transcript, independently of whether a
    // reply could be saved. Codex and Claude may supply the reply directly.
    const transcriptPath = payload.transcript_path;
    if (payload.was_in_agentic_loop !== false && typeof transcriptPath === 'string' && transcriptPath && existsSync(transcriptPath)) {
      try {
        accountRecallUse(payload.session_id, project, transcriptPath);
      } catch (err) {
        record('error', 'recall-accounting: ' + hookErrorReason(err));
        process.stderr.write('[memesh session-summary] recall-effectiveness write: ' + (err?.message || err) + '\n');
      }
    }
    if (captureHealthy) stampHookRunOnly(process.env, 'session-summary');
  } catch (err) {
    try { process.stderr.write('[memesh session-summary] ' + (err?.message || err) + '\n'); } catch {}
    record('error', hookErrorReason(err));
  }
});
