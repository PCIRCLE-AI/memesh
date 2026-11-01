#!/usr/bin/env node

// Session Auto-Capture — Stop hook
// Extracts knowledge from completed Claude Code sessions
// and stores as session-insight entities in MeMesh.
//
import { join } from 'path';
import { existsSync, readFileSync, writeSync } from 'fs';
import { pathToFileURL } from 'url';
import { setImmediate } from 'node:timers';
import {
  AUTO_CAPTURE_TAG,
  captureEntity,
  decideAutoUpdateHook,
  extractCitedMemoryIds,
  recallSessionPath,
  writePrivateJsonAtomic,
  getMemeshDirFromDbPath,
  getProjectName,
  findAutoUpdateConsent,
  isAutoCaptureEnabled,
  openHookDb,
  readUpdateCheckCache,
  redactSecrets,
  hookErrorReason,
  hookSourceHost,
  recordHookOutcome,
  recordHookRun,
  stampHookRunOnly,
  resolvePluginRoot,
  SKIP_REASONS,
  spawnAutoUpdate,
  truncateTitle,
} from './_shared.js';
import { runStopHandoff } from './_stop-handoff.js';
import { runStopNotes } from './_stop-notes.js';
// Edited file names from Bash and Edit/Write, under one path-shape rule
// (#495). Generated from src/core/bash-edited-paths.ts — do not hand-edit.
import { bashEditedFileNames, editedFileName, isPathShapedFileName } from './_generated/bash-edited-paths.js';

let installChannel = null;
try {
  const pluginRoot = resolvePluginRoot(import.meta.url);
  const modulePath = join(pluginRoot, 'dist/core/install-channel.js');
  if (existsSync(modulePath)) {
    installChannel = await import(pathToFileURL(modulePath).href);
  }
} catch {
  // Best-effort: source checkouts may not have built dist output yet.
}

async function runAutoUpdateAtStop(sessionId) {
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
    const installedVersion = typeof pkg.version === 'string' ? pkg.version : null;
    if (!installedVersion) return;

    const cache = readUpdateCheckCache(installedVersion);
    // Validate the target and cache freshness independently of the unattended
    // policy. Only exact session/version/channel approval below permits action;
    // this does not opt the owner into future automatic updates.
    const decision = decideAutoUpdateHook(installedVersion, cache, 'major');
    let channel = 'unknown';
    try { channel = installChannel?.getCurrentInstallChannel({ packageRoot: pluginRoot }) ?? 'unknown'; } catch { /* best-effort */ }
    const consent = decision.run
      ? findAutoUpdateConsent(sessionId, installedVersion, decision.latest, channel)
      : null;
    if (decision.run && consent?.decision === 'approved') {
      await spawnAutoUpdate(decision.latest, installChannel);
    }
  } catch {
    // Best-effort: update failures must never break session capture.
  }
}

// Parse a JSONL transcript file.
// Handles the current Claude Code transcript format where tool_use/tool_result
// are nested inside assistant/user message entries, not top-level entries.
// Defensive: never throws — malformed lines are silently skipped.
function parseTranscript(transcriptPath) {
  const filesEdited = new Set();
  const pendingFileEdits = new Map();
  const bashCommands = [];
  const errorsEncountered = [];
  let toolCallCount = 0;
  let readFailed = false;
  // The raw file content, returned so downstream consumers (the
  // recall-effectiveness block) reuse this single read instead of a second
  // readFileSync — real transcripts reach 47MB, so a second full read plus
  // re-parse doubles the Stop hook's dominant I/O cost.
  let rawText = '';

  try {
    rawText = readFileSync(transcriptPath, 'utf8');
    const lines = rawText.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Current format: assistant entries contain tool_use blocks in message.content
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type !== 'tool_use') continue;
            toolCallCount++;

            if (block.name === 'Write' || block.name === 'Edit') {
              const fp = block.input?.file_path ?? block.input?.path;
              const name = editedFileName(fp);
              if (name && typeof block.id === 'string') pendingFileEdits.set(block.id, [name]);
            }
            if (block.name === 'Bash') {
              const cmd = block.input?.command ?? '';
              // A session that edits through Bash — heredocs, sed -i, a
              // short python script — never produces a Write/Edit block, so
              // `filesEdited` stayed empty and the summary asserted "0 files
              // edited" for a session that edited a dozen. The count also
              // drives the re-capture guard below, so the same gap made the
              // -summary entity re-append on every Stop (#240). Recognise the
              // common in-place write shapes; anything not matched is simply
              // uncounted, which is honest — it is not asserted as zero.
              // bashEditedFileNames also rejects a captured token that is
              // not path-shaped — a shell variable, a flag, a sed/regex
              // fragment (#495) — before it can ever become a `file:` tag.
              if (typeof block.id === 'string') pendingFileEdits.set(block.id, bashEditedFileNames(cmd));
              if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
                // Redact BEFORE truncating. A bash command line is the single
                // most likely place a credential appears in a transcript
                // (`export ANTHROPIC_API_KEY=sk-...`, `curl -H "Authorization:
                // Bearer ..."`), and this text is stored verbatim as an
                // observation — a permanent, searchable, exportable copy.
                // Truncating first would cut a token in half and leave the
                // fragment unmatched by every pattern.
                bashCommands.push(redactSecrets(cmd).slice(0, 100));
              }
            }
          }
        }

        // Current format: user entries contain tool_result blocks in message.content.
        //
        // Use the explicit `is_error` flag the transcript records on each
        // tool_result instead of substring-matching the result text. The
        // earlier substring approach treated any Read/Bash output that
        // happened to contain the word "Error" (READMEs documenting errors,
        // CHANGELOG entries, source files mentioning "Error", grep over docs)
        // as a real error, drowning analyzeFailure() in noise — a 47MB
        // transcript reported 315 "errors" against ~28 real ones. The flag
        // is the canonical signal Claude Code itself uses to mark a tool as
        // having failed.
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type !== 'tool_result') continue;
            // A request is an attempt. Only its matching successful result
            // supports a completed edit-tool observation; missing/failed
            // results must not become permanent success memories.
            const files = pendingFileEdits.get(block.tool_use_id);
            if (files) {
              pendingFileEdits.delete(block.tool_use_id);
              if (block.is_error === false || block.is_error === undefined) {
                for (const file of files) filesEdited.add(file);
              }
            }
            if (block.is_error !== true) continue;
            const text = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            // Same reason as the bash branch: a failed request may echo its
            // own Authorization header. Redact once, where text enters the
            // process, so every downstream use inherits it.
            errorsEncountered.push(redactSecrets(text).slice(0, 200));
          }
        }

        // The legacy branch (top-level entry.tool_use / entry.tool_name /
        // entry.tool_result with entry.content) was confirmed dead code
        // via real-transcript audit: no Claude Code transcript ever
        // shipped that shape — current production wraps every block
        // under entry.message.content. Removed because the
        // dead branch had a confusing empty if/else (lines 133-138 of
        // the prior version) that signalled review fatigue more than
        // working logic.
      } catch {
        // Skip malformed JSONL lines — benign, per-line, deliberately not traced.
      }
    }
  } catch (err) {
    // The transcript file itself could not be read, which empties this
    // session's entire capture — filesEdited/errors/toolCallCount all return
    // zero. Left unflagged, those zeros are indistinguishable from a
    // genuinely quiet session, and the light-session bail downstream would
    // STAMP the heartbeat — repeated permission/I-O failures keeping doctor
    // green while every session's capture is lost. `readFailed` is the
    // distinct signal: capture was lost, not skipped. An absent file
    // (ENOENT) is the vanished-transcript race, which the caller already
    // treats as a correct nothing-to-do decision.
    if (err?.code !== 'ENOENT') {
      readFailed = true;
      try {
        process.stderr.write(
          `[memesh session-summary] transcript ${transcriptPath} unreadable ` +
            `(${err?.message || err}); session capture skipped this run.\n`,
        );
      } catch { /* stderr must never throw */ }
    }
  }

  return { filesEdited: [...filesEdited], bashCommands, errorsEncountered, toolCallCount, readFailed, rawText };
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

function accountRecallUse(sessionId, project, rawTranscript) {
  const filePath = recallSessionPath(join(getMemeshDirFromDbPath(), 'sessions'), sessionId, project);
  if (!filePath) {
    record('skipped', SKIP_REASONS.noSessionId);
    return;
  }
  if (!existsSync(filePath)) {
    record('skipped', SKIP_REASONS.noRecallSessionRecord);
    return;
  }
  const injection = JSON.parse(readFileSync(filePath, 'utf8'));
  if (injection.sessionId !== sessionId || injection.project !== project) {
    record('skipped', SKIP_REASONS.noRecallSessionRecord);
    return;
  }
  const entityIds = (injection.entityIds || []).filter(id => Number.isSafeInteger(id) && id > 0);
  const injectedAt = typeof injection.injectedAt === 'string' ? Date.parse(injection.injectedAt) : NaN;
  const { used, eligible } = usedMemoryIds(rawTranscript, Number.isFinite(injectedAt) ? injectedAt : Infinity);
  if (!eligible) {
    // Keep a live record fresh even when the transcript has only old rows.
    // A rebuilt record must never replay the transcript before its injection.
    writePrivateJsonAtomic(filePath, injection);
    record('skipped', SKIP_REASONS.noEligibleRecallRows);
    return;
  }
  const { db } = openHookDb(process.env, { fts: true });
  try {
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
      writePrivateJsonAtomic(filePath, { ...injection, accountingMode: ACCOUNTING_MODE,
        creditedIds: [...credited], sessionCounted: true });
    })();
  } finally {
    db.close();
  }
}

// Main: read stdin, extract insights, store in DB
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
// See post-commit.js for why every exit path leaves a record (#327).
let payload = null;
let pendingSystemMessage = null;
/** Set by runStopNotes; called by exit0() with whether the nudge went out. */
let settleNudge = null;
function record(outcome, reason, entity) {
  recordHookOutcome(process.env, { hook: 'session-summary', outcome, reason, entity, payload });
}

process.stdin.on('end', async () => {
  let sessionId;
  try {
    if (!input.trim()) {
      record('skipped', SKIP_REASONS.emptyStdin);
      return exit0();
    }

    let inputData;
    try {
      inputData = JSON.parse(input);
    } catch (parseErr) {
      // Schema mismatch / Claude Code payload-shape flip would land here.
      // Trace so the next 24h of dev surfaces it instead of months of
      // silent dropout. Mirrors user-prompt-intent.js's logError pattern.
      try {
        const preview = (input || '').slice(0, 80).replace(/\n/g, ' ');
        process.stderr.write(`[memesh session-summary] malformed stdin JSON (len=${input.length}): ${parseErr?.message || parseErr}; preview="${preview}"\n`);
      } catch {}
      record('error', 'malformed stdin JSON');
      return exit0();
    }

    payload = inputData;
    sessionId = inputData.session_id || 'unknown';
    const transcriptPath = inputData.transcript_path;

    // Opt-out check (env > config > default-on). Read before the note work
    // below because ingestion WRITES memories and must honour it; the nudge
    // writes nothing and runs either way (#324). It used to sit above the
    // JSON parse, which is why the payload is parsed first now.
    const captureEnabled = isAutoCaptureEnabled(process.env);

    // #324: ingest the project's note directory and decide the
    // "decided things, stored nothing" nudge. Records its own outcomes under
    // `note-ingest` / `remember-nudge`, never throws, and only ever yields
    // one line for exit0() to print.
    const stopProject = inputData.cwd ? getProjectName(inputData.cwd) : undefined;
    const stopNotes = await runStopNotes(inputData, {
      captureEnabled,
      project: stopProject,
      metaUrl: import.meta.url,
    });
    pendingSystemMessage = stopNotes.message;
    settleNudge = stopNotes.settle;

    // Keep the agent's last message as the project's handoff. Ahead of the
    // early exits below on purpose: a short or read-only turn is still a place
    // the work stopped, and this records its own outcome under `handoff-capture`.
    runStopHandoff(inputData, { captureEnabled, project: stopProject });

    if (!captureEnabled) {
      record('skipped', SKIP_REASONS.autoCaptureOff);
      return exit0();
    }

    // `cwd` decides the project tag, and the project tag decides which
    // sessions `session-start` injects and which memories `pre-edit-recall`
    // surfaces. Falling back to `process.cwd()` — the hook process's launch
    // directory, which is unspecified for a Stop hook — tagged the session with
    // whatever happened to be current. Measured: a payload with no `cwd` filed
    // the whole session under `project:memesh-llm-memory`, a project it had
    // nothing to do with, silently. That leaks one project's file names, bash
    // commands and error text into another project's context.
    //
    // `post-commit` refuses this exact case and says why: better to miss one
    // capture than to file it under the wrong project. Same rule here.
    if (!inputData.cwd) {
      try { process.stderr.write(`[memesh session-summary] cwd absent in payload (keys: ${Object.keys(inputData).join(',')}); cannot resolve project, skipping capture\n`); } catch {}
      record('skipped', SKIP_REASONS.cwdAbsent);
      return exit0();
    }
    const cwd = inputData.cwd;
    // Default-allow: when Claude Code's Stop payload omits
    // `was_in_agentic_loop` (it has been silently absent in production
    // for an unknown number of releases — symptom: zero session-insight
    // entities written despite hooks otherwise wired correctly), fall
    // back to "treat as agentic" so the toolCallCount<3 guard below is
    // the real low-signal filter. Earlier this field was a hard gate
    // (default-deny) and the hook silently never captured anything.
    const wasAgenticLoop = inputData.was_in_agentic_loop !== false;

    // Guards: skip low-signal sessions.
    //
    // A `stop_reason === 'user_interrupt'` guard used to live here, but
    // Claude Code's Stop payload carries no `stop_reason` field — verified
    // against the shipped cli.js bundle, whose Stop input is
    // `{...base, hook_event_name:"Stop", stop_hook_active}` with no such key
    // (the `stop_reason` that appears in the bundle is the Anthropic API
    // message field, not a hook input). So the guard read `undefined`, was
    // always false, and never skipped anything — a filter that looked active
    // but did nothing, the exact sibling of the `was_in_agentic_loop` absence
    // above. Removed; the `toolCallCount < 3` check below is the real
    // low-signal filter.
    // From here down the payload is well-formed and attributable — every
    // bail is the hook deciding "nothing worth saving", which is a
    // successful run and stamps the heartbeat. The bails ABOVE this line
    // (empty stdin, malformed JSON, missing cwd) are schema-flip shapes: if
    // Claude Code's payload changed under us, capture is effectively dead,
    // and a heartbeat would mask exactly that.
    if (!wasAgenticLoop) {
      stampHookRunOnly(process.env, 'session-summary');
      record('skipped', SKIP_REASONS.notAgenticLoop);
      return exit0();
    }
    // Trace why we're skipping. Two failure modes:
    //   (a) transcript_path absent — schema flip, Claude Code stopped
    //       sending the field. Same bug shape as `was_in_agentic_loop`
    //       (PR #39); without a trace it's invisible for months.
    //   (b) transcript_path present but file vanished — race with
    //       Claude Code's own log rotation, or a permissions issue.
    // Either way, no transcript means no extractable session knowledge,
    // so the silent-no-op is the right behaviour — but we leave a
    // breadcrumb so a schema flip doesn't ship undetected again.
    if (!transcriptPath) {
      try { process.stderr.write(`[memesh session-summary] transcript_path absent in payload (keys: ${Object.keys(inputData).join(',')}); skipping capture\n`); } catch {}
      record('skipped', SKIP_REASONS.transcriptPathAbsent);
      return exit0();
    }
    if (!existsSync(transcriptPath)) {
      try { process.stderr.write(`[memesh session-summary] transcript_path ${transcriptPath} does not exist; skipping capture\n`); } catch {}
      // The payload named a transcript and the FILE is gone (log rotation
      // race) — the hook itself ran fine, so this stamps. A payload that
      // never carried the field at all (schema flip) bails above, unstamped.
      stampHookRunOnly(process.env, 'session-summary');
      record('skipped', SKIP_REASONS.transcriptGone);
      return exit0();
    }

    // Parse transcript (single read — rawText is reused by the
    // recall-effectiveness block below)
    const { filesEdited, bashCommands, errorsEncountered, toolCallCount, readFailed, rawText: transcriptRawText } = parseTranscript(transcriptPath);

    // An unreadable transcript is NOT a quiet session: the capture was
    // LOST (permissions, I/O), and a heartbeat here would keep doctor green
    // through exactly the repeated failure it exists to expose. No stamp —
    // parseTranscript already traced the fault to stderr.
    if (readFailed) {
      record('error', 'the transcript could not be read');
      return exit0();
    }

    // A single fetch is a valid use independently of capture's activity bar.
    // All privacy/opt-out and transcript readability guards above still apply.
    try {
      accountRecallUse(inputData.session_id, getProjectName(cwd), transcriptRawText);
    } catch (err) {
      record('error', `recall-accounting: ${hookErrorReason(err)}`);
      try { process.stderr.write(`[memesh session-summary] recall-effectiveness write: ${err?.message || err}\n`); } catch {}
    }

    // Skip sessions with too little activity — the single most common
    // healthy exit, so it MUST stamp (see stampHookRunOnly).
    if (toolCallCount < 3) {
      stampHookRunOnly(process.env, 'session-summary');
      record('skipped', SKIP_REASONS.tooLittleActivity);
      return exit0();
    }

    const projectName = getProjectName(cwd);

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // { fts: true } guarantees the entities_fts table exists so captureEntity()
    // can keep it in sync — session-insight memories must be FTS-recallable.
    //
    const { db } = openHookDb(process.env, { fts: true });
    let writeFailed = false;
    let firstFailedEntity = null;
    // True once any of the three rules below actually calls storeMemory.
    // Between the toolCallCount < 3 guard above and Rule 3's >= 20 bar, a
    // session that ran real commands but edited no file matches none of
    // them — storeMemory never runs, writeFailed stays false, and without
    // this flag the outcome below fell through to record('wrote') anyway:
    // a claimed write with zero entities actually touched.
    let anyRuleMatched = false;
    // True only once captureEntity actually lands a write. A matched rule
    // whose entity is `forget`-archived sets anyRuleMatched but not this —
    // the archived branch below returns before either flag changes, so a
    // Stop where every matched rule's target was archived falls through to
    // the `!anyWrote` branch instead of a false 'wrote' (same bug shape as
    // the noRuleMatched fix above, one level deeper).
    let anyWrote = false;
    let lastWrittenEntity = null;
    try {
      // Build and store session memories
      const baseTags = [AUTO_CAPTURE_TAG, `session:${sessionId}`, `project:${projectName}`];

      // Producer for pre-edit-recall's Strategy 1 (`file:<name>` tag lookup).
      // That read path queries both the full basename and the extension-less
      // form (`file:auth.ts` OR `file:auth`), but nothing ever WROTE these
      // tags — on every real DB the query returned zero rows and the strategy
      // was dead. Emitting both forms here lights it up: a memory captured while
      // editing a file becomes findable the next time that file is edited.
      // filesEdited already holds basenames (see parseTranscript).
      function fileTagsFor(files) {
        const tags = new Set();
        for (const f of files) {
          if (!f) continue;
          tags.add(`file:${f}`);
          const noExt = f.replace(/\.[^.]+$/, '');
          // The extension-less stem goes through the same rule: `$postId.tsx`
          // is a real route file, its stem `$postId` reads as a shell variable.
          if (noExt && noExt !== f && isPathShapedFileName(noExt)) tags.add(`file:${noExt}`);
        }
        return [...tags];
      }

      // Delegate the write to the shared captureEntity() so entities land in
      // entities_fts too. This copy used to insert entity + observations + tags
      // only, skipping the FTS reindex the sibling hooks did — which left every
      // session-insight memory unrecallable via the FTS keyword path.
      //
      // Known tradeoff, not a bug: the three Rule blocks below each call this
      // function independently, and captureEntity() commits its own
      // transaction per call. A failure partway through Rule 2 or 3 can leave
      // an earlier entity (e.g. -files) replaced while a later one is not,
      // even though the overall Stop is recorded as 'error'. Wrapping all
      // three in one outer db.transaction() would close that gap (nested
      // calls become SAVEPOINTs — see MemeshDatabase.transaction() in
      // src/storage/sqlite.ts) but was deliberately not done here: it widens
      // the write-lock hold on every Stop (this hook's busy_timeout is
      // shorter than the harness timeout on purpose), to guard a failure mode
      // that self-heals — the next Stop rebuilds each entity fresh from the
      // transcript, since these are snapshots, not accumulations.
      function storeMemory(name, type, observations, tags, title) {
        anyRuleMatched = true;
        // `replace`: these three entities are a SNAPSHOT of one session, and
        // Stop fires at the end of every turn. Appending stored the same
        // sentences on every turn; skipping after the first froze a two-day
        // session at its first turn (#322). A snapshot is restated, not added
        // to.
        const result = captureEntity(db, { name, type, observations, tags, title, replace: true, sourceHost: hookSourceHost(payload, process.env) });
        if (result?.archived) {
          // The user `forget`-archived this exact entity. Not a failure —
          // captureEntity's contract left it untouched on purpose — so it
          // must not set writeFailed (that would misreport an honoured
          // `forget` as a broken hook). Traced, not silent (#3d): the next
          // Stop will try again and say the same thing until the user either
          // reactivates the entity or the session ends.
          try { process.stderr.write(`MeMesh: session-summary left "${name}" alone — archived by forget.\n`); } catch {}
          return;
        }
        // null = the entity row could not be resolved = this write did NOT
        // happen (captureEntity's contract). A run with a failed write must
        // not stamp the heartbeat below — "alive" would be a lie about the
        // exact thing the heartbeat certifies.
        if (!result) {
          writeFailed = true;
          // First failure, not last: with three independent per-entity
          // transactions, the first is the root cause — later calls run
          // regardless and naming one of them would point at a symptom.
          if (firstFailedEntity === null) firstFailedEntity = name;
          return;
        }
        anyWrote = true;
        lastWrittenEntity = name;
      }

      // No free-form human text exists for these three entities the way a
      // commit subject does — title is synthesized from the same structured
      // counts the observations already report. date+project+verb, per the
      // heuristic the design settled on for hooks with no natural title source.
      const titleDate = new Date().toISOString().slice(0, 10);
      const titlePrefix = `${titleDate} ${projectName}`;

      // Rule 1: File editing session summary — name uses the FULL
      // session_id (tests/core/extractor.test.ts pins why).
      if (filesEdited.length > 0) {
        storeMemory(
          `session-${sessionId}-files`,
          'session-insight',
          [
            `Successful file-edit tool results for ${filesEdited.length} file(s): ${filesEdited.join(', ')}`,
            `Total tool calls: ${toolCallCount}`,
          ],
          [...baseTags, ...fileTagsFor(filesEdited)],
          truncateTitle(`${titlePrefix}: successful edit tool results for ${filesEdited.length} file(s)`)
        );
      }

      // Co-occurrence is an observation, not proof that an edit fixed an error.
      if (errorsEncountered.length > 0 && filesEdited.length > 0) {
        storeMemory(
          `session-${sessionId}-fixes`,
          'session-insight',
          [
            `Observed ${errorsEncountered.length} error(s) and successful edit tool results for ${filesEdited.join(', ')}`,
            ...errorsEncountered.slice(0, 3).map(e => `Error: ${e.slice(0, 100)}`),
          ],
          [...baseTags, ...fileTagsFor(filesEdited)],
          truncateTitle(`${titlePrefix}: observed ${errorsEncountered.length} error(s) alongside edit tool results`)
        );
      }

      // Rule 3: Heavy session summary (20+ tool calls = significant work).
      // This literal is the one place that actually decides the bar; two
      // doc strings describe it in prose without importing it (this file is
      // plain JS with no shared constant module, and capture-liveness.ts is
      // a deliberate zero-import leaf) — src/core/capture-liveness.ts's
      // SKIP_REASONS.noRuleMatched and src/core/session-insight.ts's own
      // (HEAVY_SESSION_TOOL_CALLS-derived) copy. A future change to this
      // number needs both updated by hand, or doctor's text will drift from
      // what actually happened.
      if (toolCallCount >= 20) {
        storeMemory(
          `session-${sessionId}-summary`,
          'session-insight',
          [
            `Significant session: ${toolCallCount} tool calls, successful edit tool results for ${filesEdited.length} file(s)`,
            ...bashCommands.slice(0, 3).map(c => `Command: ${c}`),
          ],
          [...baseTags, 'type:heavy-session'],
          truncateTitle(`${titlePrefix}: significant session (${toolCallCount} tool calls)`)
        );
      }

      // Heartbeat AFTER capture, so the stamp certifies "the capture loop
      // completed", not "a database handle existed". A throw above skips it,
      // and so does a captureEntity null return (writeFailed) — a run whose
      // write did not land must not read as alive. (The recall-effectiveness
      // block catches its own errors — session memories were already stored
      // by then, so the run still counts.)
      if (writeFailed) {
        // Name the entity whose captureEntity call actually returned null —
        // not a fixed guess. With three independent per-entity writes, a
        // hardcoded name here would point at the wrong one whenever the
        // failure was in Rule 1 or 2.
        record('error', 'captureEntity did not land the write', firstFailedEntity ?? undefined);
      } else if (!anyRuleMatched) {
        // Correctly deciding there was nothing to capture is still a
        // completed run — same stance as the tooLittleActivity skip above,
        // which stamps too. What it must NOT do is claim 'wrote': that was
        // this hook's shape for every real-work-but-no-file-edit session
        // until this branch existed.
        recordHookRun(db, 'session-summary');
        // No entity named: by definition no rule matched, so `-files`,
        // `-fixes` and `-summary` are all equally untouched this Stop —
        // naming one of them would misreport which entity this record is
        // about.
        record('skipped', SKIP_REASONS.noRuleMatched);
      } else if (!anyWrote) {
        // A rule DID match, but every entity it targeted was `forget`-
        // archived — the same false-'wrote' shape as the branch above, one
        // level deeper (a matched rule that produced no write). Its own
        // reason, not noRuleMatched: a rule fired, saying otherwise would
        // hide that.
        recordHookRun(db, 'session-summary');
        record('skipped', SKIP_REASONS.allMatchedEntitiesArchived);
      } else {
        recordHookRun(db, 'session-summary');
        // Name the entity that actually landed the write (the last one, if
        // more than one rule wrote) — not a fixed guess at which of the
        // three this Stop touched.
        record('wrote', undefined, lastWrittenEntity ?? undefined);
      }
    } finally {
      db.close();
    }

  } catch (err) {
    // Never crash Claude Code — leave a trace for debugging.
    //
    // Every error is traced. A retired suppression sentinel once hid setup
    // failures from this hook; with that branch gone, real capture errors stay
    // visible without crashing the host session.
    try { process.stderr.write(`[memesh session-summary] ${err?.message || err}\n`); } catch {}
    record('error', hookErrorReason(err));
  }

  // Emit NOTHING on success — not `{"suppressOutput": true}`.
  //
  // That field is valid Claude Code hook output, and it was doing no work:
  // this hook writes nothing else to stdout, so there was never any output
  // to suppress. But Codex CLI validates hook output per event against its
  // own schema, and rejects the field on Stop — reported from a live
  // Codex session as "hook returned invalid stop hook JSON output",
  // once per turn, with the capture itself having already succeeded.
  //
  // Empty stdout with exit 0 is the "no opinion" signal in BOTH contracts,
  // and it is what `validateHookOutput` already classifies as `kind: 'empty'`.
  // So the portable answer is silence, and the field's only remaining effect
  // was to fail one host for no benefit on the other.
  exit0();
});

async function exit0() {
  // All valid Stop paths, including short turns and capture opt-out, settle
  // explicit update consent. Yield so enclosing capture finally blocks close
  // their resources before installed files could change.
  await new Promise(resolve => setImmediate(resolve));
  if (payload) await runAutoUpdateAtStop(payload.session_id || 'unknown');
  // The one thing this hook may print (#324): the nudge. `systemMessage` is
  // the only Stop output Claude Code shows the user (Stop has no
  // hookSpecificOutput variant — tests/helpers/hook-output-contract.ts).
  // Codex's acceptance of it on Stop is NOT verified against a live Codex in
  // this repository; tests/hooks/cross-host-output-contract.test.ts pins the
  // exact envelope so a rejection report maps to one line. `suppressOutput`,
  // which Codex did reject, stays gone. writeSync, not console.log: stdout is a
  // pipe, and an async pipe write can be cut off by process.exit on macOS.
  //
  // The nudge's outcome is decided HERE, by whether the write succeeded —
  // not by runStopNotes, which cannot know. A host that closed stdout gets
  // an `error` record and keeps its transcript offset, so the next Stop
  // judges the same window again instead of losing it to a line nobody read.
  let delivered = true;
  if (pendingSystemMessage) {
    try {
      writeSync(1, `${JSON.stringify({ systemMessage: pendingSystemMessage })}\n`);
    } catch {
      delivered = false; // host closed stdout; the record says so.
    }
  }
  try { settleNudge?.(delivered); } catch { /* diagnostics never take the hook down */ }
  process.exit(0);
}
