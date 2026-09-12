#!/usr/bin/env node

// Session Auto-Capture — Stop hook
// Extracts knowledge from completed Claude Code sessions
// and stores as session-insight entities in MeMesh.
//
import { createRequire } from 'module';
import { basename, join } from 'path';
import { existsSync, readFileSync, writeSync } from 'fs';
import { pathToFileURL } from 'url';
import {
  AUTO_CAPTURE_TAG,
  captureEntity,
  decideAutoUpdateHook,
  extractCitedMemoryIds,
  getMemeshDirFromDbPath,
  getProjectName,
  findAutoUpdateConsent,
  isAutoCaptureEnabled,
  openHookDb,
  readUpdateCheckCache,
  redactSecrets,
  hookErrorReason,
  recordHookOutcome,
  recordHookRun,
  stampHookRunOnly,
  resolveAutoUpdatePolicy,
  resolvePluginRoot,
  SKIP_REASONS,
  spawnAutoUpdate,
  truncateTitle,
} from './_shared.js';
import { runStopNotes } from './_stop-notes.js';

const require = createRequire(import.meta.url);

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
    const policy = resolveAutoUpdatePolicy(process.env);
    const decision = decideAutoUpdateHook(installedVersion, cache, policy);
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
/**
 * File paths a shell command writes in place. Recognises the shapes an
 * agent actually uses to edit without Write/Edit: heredoc redirection
 * (`> path <<'EOF'`, `cat > path`), `sed -i`, `tee`, and `pathlib.Path('x')
 * .write_text(` / `fs.writeFileSync('x'` inside an inline script. Returns
 * basenames' sources; the caller keeps basename() as the stored form.
 */
function bashEditedPaths(cmd) {
  if (typeof cmd !== 'string') return [];
  const found = new Set();
  const add = (m) => { if (m && m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/')) found.add(m[1]); };
  for (const re of [
    /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/g,   // > file <<'EOF'
    /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/g,                            // cat > file
    /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/g,                      // tee file
    /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/g, // sed -i '...' file
    /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/g,           // pathlib write_text
    /writeFileSync\(\s*['"]([^'"]+)['"]/g,                        // fs.writeFileSync
  ]) {
    let m; while ((m = re.exec(cmd)) !== null) add(m);
  }
  return [...found];
}

function parseTranscript(transcriptPath) {
  const filesEdited = new Set();
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
              if (fp && typeof fp === 'string') filesEdited.add(basename(fp));
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
              for (const fp of bashEditedPaths(cmd)) filesEdited.add(basename(fp));
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
  let sessionId = 'unknown';
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
    const stopNotes = await runStopNotes(inputData, {
      captureEnabled,
      project: inputData.cwd ? getProjectName(inputData.cwd) : undefined,
      metaUrl: import.meta.url,
    });
    pendingSystemMessage = stopNotes.message;
    settleNudge = stopNotes.settle;

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
          if (noExt && noExt !== f) tags.add(`file:${noExt}`);
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
        const result = captureEntity(db, { name, type, observations, tags, title, replace: true });
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
            `Session edited ${filesEdited.length} file(s): ${filesEdited.join(', ')}`,
            `Total tool calls: ${toolCallCount}`,
          ],
          [...baseTags, ...fileTagsFor(filesEdited)],
          truncateTitle(`${titlePrefix}: edited ${filesEdited.length} file(s)`)
        );
      }

      // Rule 2: Error -> Fix pattern detection
      if (errorsEncountered.length > 0 && filesEdited.length > 0) {
        storeMemory(
          `session-${sessionId}-fixes`,
          'session-insight',
          [
            `Fixed ${errorsEncountered.length} error(s) by editing ${filesEdited.join(', ')}`,
            ...errorsEncountered.slice(0, 3).map(e => `Error: ${e.slice(0, 100)}`),
          ],
          [...baseTags, 'type:bugfix', ...fileTagsFor(filesEdited)],
          truncateTitle(`${titlePrefix}: fixed ${errorsEncountered.length} error(s)`)
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
            `Significant session: ${toolCallCount} tool calls, ${filesEdited.length} files edited`,
            ...bashCommands.slice(0, 3).map(c => `Command: ${c}`),
          ],
          [...baseTags, 'type:heavy-session'],
          truncateTitle(`${titlePrefix}: significant session (${toolCallCount} tool calls)`)
        );
      }

      // ── Recall effectiveness tracking ────────────────────────────────
      // Read which entities were injected at session start, check if
      // their names appear in the transcript, update hits/misses.
      try {
        // FIX: Find the most recent session file for this project (within last hour)
        const sessionsDir = join(getMemeshDirFromDbPath(), 'sessions');
        let injectedData = null;

        if (existsSync(sessionsDir)) {
          const files = require('fs').readdirSync(sessionsDir);
          const recentFiles = files
            .filter(f => f.endsWith('.json'))
            .map(f => {
              const path = join(sessionsDir, f);
              try {
                const stats = require('fs').statSync(path);
                return { path, mtime: stats.mtimeMs };
              } catch (err) {
                // statSync threw — file vanished between readdir and stat,
                // or perms changed mid-scan. Skip but trace.
                try { process.stderr.write(`[memesh session-summary] sessions-stat ${path}: ${err?.message || err}\n`); } catch {}
                return null;
              }
            })
            .filter(f => f && Date.now() - f.mtime < 60 * 60 * 1000) // within 1 hour
            .sort((a, b) => b.mtime - a.mtime); // newest first

          // Try to find matching project, otherwise use most recent
          for (const { path } of recentFiles) {
            try {
              const data = JSON.parse(readFileSync(path, 'utf8'));
              // Project match must be exact. The earlier
              // `|| recentFiles.length === 1` fallback caused
              // cross-project recall-effectiveness leakage: with two
              // concurrent Claude Code sessions in two repos, a
              // project-mismatched Stop hook would pick up the OTHER
              // project's entityIds and update THEIR hits/misses
              // against this transcript. Lose one session's tracking
              // rather than corrupt another's.
              if (data.project === projectName) {
                injectedData = data;
                // Delete after reading to prevent reuse
                require('fs').unlinkSync(path);
                break;
              }
            } catch (err) {
              // Three failure modes share this catch: JSON.parse on a
              // corrupt session file, readFileSync on a perm-changed file,
              // unlinkSync after read. Trace each so a silent unlink
              // failure (which would re-count the same session) is
              // visible. Loop continues to the next file regardless.
              try { process.stderr.write(`[memesh session-summary] sessions-read ${path}: ${err?.message || err}\n`); } catch {}
            }
          }
        }

        if (injectedData) {
          const { entityIds } = injectedData;

          if (entityIds && entityIds.length > 0) {
            // Check if recall_hits column exists (v4.0+ migration)
            const colCheck = db.prepare("PRAGMA table_info(entities)").all();
            if (colCheck.some(c => c.name === 'recall_hits')) {
              // Drop the records Claude Code created FROM our own hook
              // output before scanning: the injected block itself prints a
              // `[mem:id]` handle on every line, and counting those would
              // score every injection as a hit. Structural removal is
              // copy-count and encoding independent. Reuse the raw text
              // parseTranscript already read — a second readFileSync
              // doubles the Stop hook's I/O on 47MB transcripts.
              const sessionText = stripHookEchoes(transcriptRawText);

              // Citation accounting. A hit is an EXPLICIT `[mem:id]` marker
              // the agent wrote for an id this session injected — the
              // instruction line session-start appends after the fenced
              // block. Literal-content matching (the previous accounting)
              // was retired after measuring 0% signal across ten real
              // sessions and three matching strategies: every injected
              // memory drifted toward an unearned recall_miss, and misses
              // feed the impact factor in core ranking.
              //
              // Markers are self-reported: an agent that used a memory
              // silently earns it nothing, so the signal UNDERCOUNTS and
              // never overcounts. That asymmetry is why misses are FROZEN —
              // recall_misses stays untouched until measured marker
              // compliance (the counters below) justifies reading silence
              // as non-use. The mode stamp keeps the two eras of numbers
              // apart.
              const cited = extractCitedMemoryIds(sessionText);
              const updateHit = db.prepare(
                'UPDATE entities SET recall_hits = COALESCE(recall_hits, 0) + 1 WHERE id = ?'
              );
              // Counted here, not recomputed below. The compliance
              // numerator and `recall_hits` have to be the SAME
              // measurement: `cited.size > 0` asked "did this transcript
              // contain any [mem:N] at all", which counts a marker for an id
              // this session never injected — one carried over from an
              // earlier turn, or a number the agent invented — as compliance.
              // The denominator counts sessions that received an injection,
              // so the two halves of the rate were answering different
              // questions.
              let injectedAndCited = 0;
              for (const id of entityIds) {
                if (cited.has(id)) {
                  updateHit.run(id);
                  injectedAndCited++;
                }
              }

              // Accounting-mode stamp (constant value, rewritten every
              // session so it survives DB restores from either era) plus
              // the compliance denominators: sessions that HAD an injection
              // vs sessions whose transcript carried any citation marker.
              //
              // The counters are scoped to the generation named in the stamp.
              // When a graph that counted under an EARLIER generation meets
              // this one, they are cleared rather than added to: the
              // numerator changed meaning (v1 asked "did the transcript
              // contain any marker", v2 asks "was an id we injected cited"),
              // so a sum across both is one ratio wearing the newer label and
              // no key separates the eras. Readers — analytics.ts and
              // scripts/audit/measure-signals.mjs — read the bare keys and
              // therefore keep working unchanged; what they report is now
              // this generation only. A graph that never counted has no
              // stamp, so nothing resets on a new install.
              const ACCOUNTING_MODE = 'citation-v2 since 2026-09-12';
              const priorMode = db.prepare(
                "SELECT value FROM memesh_metadata WHERE key = 'recall_accounting_mode'"
              ).get()?.value;
              if (priorMode && priorMode !== ACCOUNTING_MODE) {
                // Traced, not silently dropped: the numbers being discarded
                // are the only record of the previous era, and a reset that
                // leaves no result record is the silent-skip shape.
                const prior = (key) => db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key)?.value ?? 'absent';
                const priorTotal = prior('citation_sessions_total');
                const priorCited = prior('citation_sessions_cited');
                db.prepare(
                  "DELETE FROM memesh_metadata WHERE key IN ('citation_sessions_total', 'citation_sessions_cited')"
                ).run();
                try {
                  process.stderr.write(
                    `[memesh session-summary] citation accounting generation changed (${priorMode} -> ${ACCOUNTING_MODE}); ` +
                      `counters reset from total=${priorTotal} cited=${priorCited} — the two eras count different things and are not comparable.\n`,
                  );
                } catch {}
              }
              db.prepare(
                'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
              ).run('recall_accounting_mode', ACCOUNTING_MODE);
              const bump = db.prepare(
                `INSERT INTO memesh_metadata (key, value) VALUES (?, '1')
                 ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
              );
              bump.run('citation_sessions_total');
              // Initialised unconditionally, then bumped. Writing it only on
              // a citation made "zero sessions cited" and "this code never
              // ran" the same absent key — and that is exactly what a real
              // database showed on 2026-08-24: total=4, cited absent, with
              // no way to tell a 0% compliance rate from a dead counter.
              db.prepare(
                `INSERT INTO memesh_metadata (key, value) VALUES ('citation_sessions_cited', '0')
                 ON CONFLICT(key) DO NOTHING`
              ).run();
              if (injectedAndCited > 0) bump.run('citation_sessions_cited');
            }
          }
        }
      } catch (err) {
        // Recall-effectiveness DB write failed. Silently dropping this
        // converges impact scores to 0.5 (neutral) for every entity, which
        // is the main signal core/scoring.ts uses to demote ignored
        // memories — a real-world UX issue. Trace to stderr so a typo or
        // missing-column failure is visible without crashing the hook.
        try { process.stderr.write(`[memesh session-summary] recall-effectiveness write: ${err?.message || err}\n`); } catch {}
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

  // Update only after all session work so installed files cannot change while
  // this hook is still reading them.
  await runAutoUpdateAtStop(sessionId);

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

function exit0() {
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
/**
 * Attachment record types Claude Code uses to persist a hook's own output
 * into the transcript. Anything memesh injected reaches the transcript
 * through one of these, so they must be removed before asking "did the
 * session reference this memory?".
 *
 * Verified against Claude Code v2.1.19: ONE SessionStart injection lands in
 * the transcript at least twice — once as `hook_success` (carrying the raw
 * hook stdout) and once as `hook_additional_context` (the parsed payload).
 */
const HOOK_ECHO_ATTACHMENT_TYPES = new Set([
  'hook_success',
  'hook_additional_context',
  'hook_system_message',
]);

/**
 * Remove memesh's own injected text from a raw JSONL transcript.
 *
 * Counting occurrences and subtracting the injected copies does NOT work:
 * it depends on knowing exactly how many times Claude Code echoes a hook
 * payload, which is an undocumented internal that has already been observed
 * at 2+ copies (and 16 in one real transcript). Guessing that constant is
 * how "every entity is a miss" becomes "every entity is a hit" — equally
 * useless, and invisible to a hand-built test fixture.
 *
 * Dropping the hook-echo records structurally is independent of both the
 * copy count and the JSON escaping.
 */
export function stripHookEchoes(rawTranscript) {
  const kept = [];
  for (const line of String(rawTranscript ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Unparseable line: keep it. Losing a line can only cause a false
      // MISS (we under-count references), which is the safe direction —
      // it never manufactures a hit the session did not earn.
      kept.push(line);
      continue;
    }
    const type = entry?.attachment?.type ?? entry?.type;
    if (typeof type === 'string' && HOOK_ECHO_ATTACHMENT_TYPES.has(type)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}
