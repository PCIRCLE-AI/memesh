#!/usr/bin/env node

// Continuous Recall — PreToolUse hook for Edit/Write
// When editing a file, checks if MeMesh has relevant memories
// and injects them as context. Throttled: max 1 recall per file per session.
//
// Also the Edit/Write evaluation point for lesson guards (G1): accepted
// guards match against the path plus the content about to be written, and
// a hit injects the lesson's warning at the exact moment its mistake is
// about to repeat. Guards are NOT throttled — a dangerous edit is
// dangerous every time.

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { existsSync, readFileSync, realpathSync } from 'fs';
import {
  buildReferenceContext,
  containsFileNameLiterally,
  ensurePrivateDir,
  getDbPath,
  getMemeshDirFromDbPath,
  getProjectName,
  gitRepoRoot,
  HOOK_BUSY_TIMEOUT_MS,
  isTrustedForAutoContext,
  writePrivateJson,
  hookMatchExpression,
  hookPhraseExpression,
  loadActiveGuards,
  matchingGuards,
  guardWarningLines,
  recordGuardFires,
  hookErrorReason,
  SKIP_REASONS,
  SESSION_SNAPSHOT_TYPES,
  recordHookOutcome,
} from './_shared.js';
import { MemeshDatabase } from './_generated/sqlite.js';

const dbPath = getDbPath();
const memeshDir = getMemeshDirFromDbPath();
const THROTTLE_FILE = join(memeshDir, 'session-recalled-files.json');
const MAX_RESULTS = 3;

// #358 round 3 item 2: Strategy 2 fetches this many CANDIDATES before literal
// confirmation narrows them, then cuts to MAX_RESULTS. Confirmation cannot
// run inside SQL (it reads observations text, not just an index), so a
// candidate LIMIT that is too tight can starve it: 9 candidates that all
// fail confirmation hid a 10th, genuinely-matching row entirely (reported,
// reproduced through the real hook). The window costs one indexed
// `observations` lookup per candidate (idx_observations_entity); what the
// query costs is set by how many rows match, not by this LIMIT (#366).
const CANDIDATE_WINDOW = 50;

// #358 AC1: auto-captured session-snapshot rows never qualify as a RECALL
// match, in either strategy below — see SESSION_SNAPSHOT_TYPES for why.
const SESSION_SNAPSHOT_TYPE_LIST = [...SESSION_SNAPSHOT_TYPES];
const SESSION_SNAPSHOT_EXCLUSION_SQL =
  `AND e.type NOT IN (${SESSION_SNAPSHOT_TYPE_LIST.map(() => '?').join(',')})`;

let input = '';
// See post-commit.js for why every exit path leaves a record (#327).
let payload = null;
function record(outcome, reason, entity) {
  recordHookOutcome(process.env, { hook: 'pre-edit-recall', outcome, reason, entity, payload });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    payload = data;
    if (!data.tool_input) {
      // Schema-flip signal — Claude Code has renamed `tool_input` for
      // transcript blocks before. Trace so the rename surfaces day-1.
      try { process.stderr.write(`[memesh pre-edit-recall] tool_input absent (keys: ${Object.keys(data).join(',')}); skipping\n`); } catch {}
      record('skipped', SKIP_REASONS.toolInputAbsent);
      return pass();
    }
    const toolInput = data.tool_input;
    const filePath = toolInput.file_path || toolInput.path || '';

    // Only process if we have a file path
    if (!filePath || typeof filePath !== 'string') {
      record('skipped', SKIP_REASONS.noFilePath);
      return pass();
    }
    const fileName = basename(filePath);
    const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');

    // Throttle — the RECALL half runs once per file per session. The guard
    // half is deliberately outside it, so a throttled call still opens the
    // database for the guard pass.
    const fileKey = filePath.toLowerCase();
    let seenFiles = [];
    try {
      if (existsSync(THROTTLE_FILE)) {
        const raw = JSON.parse(readFileSync(THROTTLE_FILE, 'utf8'));
        seenFiles = Array.isArray(raw) ? raw : [];
      }
    } catch {
      seenFiles = [];
    }
    const throttled = seenFiles.includes(fileKey);

    if (!existsSync(dbPath)) {
      record('skipped', SKIP_REASONS.noDatabaseForRecall);
      return pass();
    }

    // Project used to scope RECALL — derived from the EDITED FILE's own
    // location, not cwd (#358 AC3): a file living in another repository
    // (this machine's `~/.claude` checkout, say, edited while cwd is some
    // other project) used to have every one of ITS OWN project-tagged
    // memories filtered out by a project tag it never carried, leaving only
    // whatever cwd's unrelated project happened to contain. Falls back to
    // cwd's project when the file's directory is not inside a git repo, or
    // when resolving it throws: a plain-directory identity for a scratch /
    // non-repo path is a worse proxy for "this file's project" than the
    // session's own project context — which is the behaviour every edit had
    // before this fix, so a non-repo file keeps it. When the file's project
    // equals cwd's project (the common case: editing inside the session's
    // own repo) this resolves to the same tag as before.
    //
    // Deliberately NOT widened to a global namespace or an "also search
    // cwd's project" OR — out of scope for #358 and its own source of
    // cross-project noise.
    //
    // Measured with a PATH-shim `git` wrapper against three fixtures (#358
    // round 7), current code vs. HEAD (no per-file project scoping) run
    // against the same three fixtures the same way:
    //   - repo with a remote: 2 now (gitRepoRoot's `rev-parse
    //     --show-toplevel`, then getProjectName's own `config --get
    //     remote.origin.url`, which finds the remote and stops) vs. 1 at
    //     HEAD (`getProjectName(cwd)` alone, the remote check only).
    //   - non-repo fallback: 3 now (gitRepoRoot's call finds no repo, so
    //     getProjectName runs again on cwd instead: `config --get
    //     remote.origin.url` then `rev-parse --show-toplevel`, both empty)
    //     vs. 2 at HEAD (the same two, minus gitRepoRoot's own call).
    //   - repo with no remote: 4 now (the with-remote two, plus
    //     getProjectName's own fallback `rev-parse --show-toplevel` and
    //     `rev-parse --git-common-dir` once the remote check is empty) vs.
    //     3 at HEAD (the same three, minus gitRepoRoot's own call).
    // Adds exactly one git process per unthrottled edit in every case. Each
    // is capped at 2 s (`tryGit`), so where git itself stalls the hook's
    // 5-second timeout is reached one call sooner than before (#366). The
    // throttled path (every repeat edit of the same file) pays for none of it.
    // Guards are global by design: a mistake recorded in one project is
    // usually a mistake everywhere (the pipe-eats-exit-code shape), and the
    // warning names its
    // source lesson either way.
    let projectName = null;
    // The edited file's own path, forward-slash-normalised, for the literal
    // confirmation's path-suffix check (#358 round 3 item 3b) — `relPath` is
    // relative to the file's repo root, `absPath` is always set. `null`
    // (throttled, or the try below threw) means Strategy 2 never runs, so no
    // path info is ever needed.
    let editedPath = null;
    if (!throttled) {
      try {
        const rawDir = dirname(filePath);
        const absoluteFileDir = isAbsolute(rawDir) ? rawDir : resolve(data.cwd || process.cwd(), rawDir);
        // #358 F3: realpath the nearest EXISTING ancestor before asking for
        // its project. A symlinked directory can make the git-plumbing
        // identity resolution key off the symlink's own path instead of the
        // real repository; feeding it an already-resolved directory
        // sidesteps that without touching `resolveProjectIdentity` itself.
        const { dir: fileDir, tail: missingTail } = realpathNearestExisting(absoluteFileDir);
        // One call serves both project scoping and the path-suffix check
        // below.
        const repoRoot = gitRepoRoot(fileDir);
        projectName = repoRoot ? getProjectName(fileDir) : getProjectName(data.cwd);

        // `fileDir` is only the nearest ancestor that EXISTS — right for
        // project identity, wrong as the file's own directory. A `Write`
        // into `docs/new/deep/` would otherwise be checked as `docs/<file>`,
        // a different, real file, and admit memories about it. The
        // components the walk dropped go back on.
        const resolvedFilePath = join(fileDir, missingTail, fileName);
        const absPath = resolvedFilePath.split(sep).join('/');
        // #358 round 4 finding 5: `fileDir` is realpath'd (F3, above), so a
        // symlinked ancestor (macOS `/var` -> `/private/var`) makes `absPath`
        // the CANONICAL form only — a memory naming the AS-GIVEN form (the
        // symlink itself, e.g. `/var/...`) would then never match, even
        // though it is the exact same file. `absoluteFileDir` (already in
        // scope, computed above BEFORE realpath) gives that form for free —
        // no extra filesystem call, just a string join, so this costs
        // nothing extra on the hot path per candidate.
        const asGivenPath = join(absoluteFileDir, fileName).split(sep).join('/');
        const absPathAsGiven = asGivenPath === absPath ? undefined : asGivenPath;
        let relPath = null;
        if (repoRoot) {
          const rel = relative(repoRoot, resolvedFilePath).split(sep).join('/');
          // A `..`-leading result means the file is not under the root git
          // reported (two spellings of one directory that realpath did not
          // reconcile). That is not "this file's path within its repo" —
          // treat it as unavailable rather than match against it.
          if (!rel.startsWith('..')) relPath = rel;
        }
        editedPath = { relPath, absPath, absPathAsGiven };
      } catch {
        projectName = getProjectName(data.cwd);
      }
    }

    // `readOnly`, not `readonly`: node:sqlite ignores the lowercase spelling
    // and hands back a WRITABLE handle. This hook only reads; the guard
    // fire counter opens its own writable handle for its one UPDATE.
    const db = new MemeshDatabase(dbPath, { readOnly: true });
    // MemeshDatabase's constructor always sets busy_timeout to the 30s that
    // is correct for the CLI/MCP/HTTP writers; this hook's own budget
    // (hooks.json) is 5s, so left alone a contended lock outlives the hook.
    db.pragma(`busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
    // A single probe before either pass below. `loadActiveGuards` swallows
    // a query failure internally — by design, so a guard-matching problem
    // can never be the reason this hook crashes — which means a lock still
    // held after the busy_timeout wait comes back as "no guards matched"
    // rather than as an error this hook can see. Unlike guard-check.js,
    // this hook still has the recall pass to run after the guard pass, and
    // that query is NOT swallowed — so a genuinely contended connection
    // paid the full busy_timeout wait TWICE in sequence, once hidden and
    // once fatal, before giving up. Probing once here means a contended
    // database is discovered (and given up on) after paying that wait
    // exactly once.
    try {
      db.prepare('SELECT 1').get();
    } catch {
      db.close();
      record('error', 'the database stayed locked past the hook busy timeout');
      return pass();
    }
    let guardMatches = [];
    const recallLines = [];
    // #358 round 3 item 2: true when Strategy 2's candidate query returned
    // exactly CANDIDATE_WINDOW rows — evidence that MORE candidates may
    // exist past what was fetched, so a subsequent "nothing to recall" would
    // be a claim this run cannot back. Declared here (not inside the block
    // that sets it) so the final skip-reason decision below can read it.
    let candidateWindowTruncated = false;
    // A fault while reading `observations` (confirmation or the display
    // snippet). Held, not thrown: the guard half was evaluated first and its
    // warning must still be emitted; the run is then recorded as an `error`.
    let recallFault = null;
    try {
      // Guard pass (G1) — matched against the path plus the content about
      // to land, which is what the mistake would be made OF.
      const toolName = data.tool_name === 'Write' ? 'Write' : 'Edit';
      const guardHaystack = `${filePath}\n${toolInput.new_string ?? toolInput.content ?? ''}`;
      guardMatches = matchingGuards(loadActiveGuards(db, toolName), toolName, guardHaystack);

      // Recall pass — throttled, project-scoped.
      if (!throttled) {
        // Check if entities table exists
        // Both tables, not just `entities`. Strategy 2 below joins entities_fts,
        // and this hook opens the database READ-ONLY without going through
        // openHookDb, so it never creates that table. Checking only `entities`
        // meant a structurally-absent index reached the query and failed there —
        // which, now that the failure is no longer swallowed, would print on
        // every single Edit.
        const tables = new Set(
          db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities','entities_fts')"
          ).all().map((r) => r.name)
        );
        if (tables.has('entities')) {
          const hasFts = tables.has('entities_fts');

          const hasStatus = db.prepare("PRAGMA table_info(entities)").all()
            .some(c => c.name === 'status');
          const statusFilter = hasStatus ? "AND e.status = 'active'" : '';

          // Search strategies (fileName/fileNameNoExt computed above, before
          // the throttle check, so the project-resolution block can use them
          // too):
          // 1. Entities tagged with the exact full basename (e.g., "file:auth.ts")
          // 2. FTS5 search on the basename, confirmed by a literal-text check
          const results = [];

          // Strategy 1: Tag-based search — the EXACT full basename tag only
          // (#358 AC2 round 2). The producer (session-insight.ts) writes
          // BOTH `file:<full>` and `file:<stem>` per file, so matching the
          // stem form too meant editing `auth.ts` matched a memory tagged
          // only `file:auth` for a DIFFERENT file (`auth.py`, `auth.rs`,
          // ...) — the stem is not unique to this file, the full basename is.
          // When the edited file has no extension, `fileNameNoExt ===
          // fileName`, so this already covers that case without a second arm.
          //
          // CRITICAL: Filter by project to prevent cross-project memory injection
          // CRITICAL: Exclude auto-captured session-snapshot rows (#358 AC1) —
          // session-insight's `-files`/`-fixes` entities carry a `file:<name>`
          // tag for every file the session touched, so without this they
          // satisfy this exact-tag strategy for any file ever edited that
          // session. `commit` stays eligible: a commit can genuinely be about
          // the file being edited.
          const projectTag = `project:${projectName}`;
          const tagResults = db.prepare(`
            SELECT DISTINCT e.id, e.name, e.type, e.metadata
            FROM entities e
            JOIN tags t1 ON t1.entity_id = e.id
            JOIN tags t2 ON t2.entity_id = e.id
            WHERE t1.tag = ?
              AND t2.tag = ?
              ${SESSION_SNAPSHOT_EXCLUSION_SQL}
            ${statusFilter}
            LIMIT ?
          `).all(
            `file:${fileName}`, projectTag,
            ...SESSION_SNAPSHOT_TYPE_LIST, MAX_RESULTS * 3
          );
          results.push(...tagResults.filter((row) => isTrustedForAutoContext(row.metadata)));

          // Strategy 2: FTS5 search on file name (if not enough results)
          // CRITICAL: Filter by project to prevent cross-project memory injection
          // CRITICAL: Exclude auto-captured session-snapshot rows (#358 AC1) —
          // same reasoning as Strategy 1; their observation prose routinely
          // NAMES other files the session touched, so an unqualified FTS
          // match reaches them even without a matching tag.
          //
          // No minimum-length gate on the stem (#358 round 3 item 4 — this
          // used to require `fileNameNoExt.length >= 4`, which made `設定.ts`,
          // `c++.md` and `*.ts` unreachable even with an exact literal
          // mention). Literal confirmation below is what keeps a short or
          // symbol-heavy name safe now, not query length; the sole remaining
          // gate is `hookPhraseExpression`/`hookMatchExpression` returning
          // `null` when the basename tokenises to nothing at all to search
          // for (handled where `matchExpr` is built, same as before).
          if (hasFts && results.length < MAX_RESULTS) {
            // An ASCII basename gets a PHRASE query — every one of its words,
            // extension included, adjacent and in order ("CLAUDE.md" ->
            // `"CLAUDE md"`). A non-ASCII basename (CJK, Thai,
            // decomposed-Unicode, ...) keeps the OR-of-bigrams path instead:
            // `hookMatchExpression` pre-segments such text into overlapping
            // bigrams (built by the same function core uses, so this query
            // asks for the tokens the index actually holds — quoting the raw
            // basename instead meant a CJK or decomposed-Unicode filename
            // matched nothing at all against the segmented index, and the
            // catch below made that invisible), and a phrase built from an
            // arbitrary subset of those bigrams is not the same question a
            // phrase is meant to answer.
            //
            // Neither query proves the text is actually ABOUT this file —
            // both are CANDIDATE GENERATORS, confirmed below. A phrase hit is
            // not a filename hit: "05-CLAUDE-md.md" tokenizes to a "claude"
            // token immediately followed by "md", and prose like
            // "claude-md", "CLAUDE_MD" or "the Claude MD file" all satisfy a
            // token-adjacency check without ever containing the literal
            // string "CLAUDE.md" (#358 round 2). A stem that tokenizes to
            // nothing is the same failure from the other side: editing
            // `----.ts` degenerates the phrase to the single term `"ts"`,
            // which then matches ANY text that merely mentions "ts".
            // The full ASCII range (0x00-0x7F) is what "ASCII" means here,
            // not a stray control character left in by mistake.
            // eslint-disable-next-line no-control-regex
            const isAsciiBasename = /^[\x00-\x7f]*$/.test(fileNameNoExt);
            // The candidate generator is allowed to search on the STEM only
            // (both paths above do, for the ASCII path only via the phrase
            // still including the extension token) — but confirmation ALWAYS
            // requires the FULL basename, extension included, for EVERY
            // script (#358 round 3 item 1). A stem-only generator match is
            // still just a candidate: editing `設定配置.ts`, a memory saying
            // "See 設定配置.py before editing" or "See 設定配置 before
            // editing" both satisfy the non-ASCII candidate generator (same
            // stem bigrams) but neither literally names THIS file — the
            // round-2 version confirmed only the stem and injected both.
            const confirmNeedle = fileName;
            const matchExpr = isAsciiBasename
              ? hookPhraseExpression(fileName)
              : hookMatchExpression(fileNameNoExt);
            let ftsResults = [];
            try {
              // ORDER BY rank still matters: literal confirmation runs AFTER
              // this query's own LIMIT, so when more rows match the
              // prefilter than the LIMIT allows, rank decides which subset
              // is even offered to the confirmation step. `hookMatchExpression`
              // emits `"knowledge" OR "graph"` for `knowledge-graph.ts` —
              // necessary, because a CJK basename has to be reachable by its
              // bigrams — which makes the match set large and unranked
              // selection IS the result: editing that file in a project
              // whose memories merely mention "graph" injected whatever the
              // scan happened to reach first, where the old code correctly
              // injected nothing. BM25 is what makes the OR safe; without it
              // the fix trades a CJK miss for an ASCII false hit.
              //
              // LIMIT is CANDIDATE_WINDOW, not a small multiple of the slots
              // still open (#358 round 3 item 2): literal confirmation below
              // can reject any of these, and a tight LIMIT applied BEFORE
              // confirmation can starve it — 9 candidates that all fail
              // confirmation hid a 10th, genuinely-matching row entirely.
              ftsResults = matchExpr === null ? [] : db.prepare(`
                SELECT DISTINCT e.id, e.name, e.type, e.metadata
                FROM entities e
                JOIN entities_fts fts ON fts.rowid = e.id
                JOIN tags t ON t.entity_id = e.id
                WHERE entities_fts MATCH ?
                  AND t.tag = ?
                  ${SESSION_SNAPSHOT_EXCLUSION_SQL}
                ${statusFilter}
                ORDER BY fts.rank, e.id DESC
                LIMIT ?
              `).all(
                matchExpr, projectTag,
                ...SESSION_SNAPSHOT_TYPE_LIST, CANDIDATE_WINDOW
              );
            } catch (err) {
              // Never fail the user's edit over a recall miss, but do not pretend
              // nothing happened either: a silently-skipped FTS query is how this
              // hook injected zero memories for months without anyone noticing.
              //
              // Throttled, because PreToolUse fires a fresh process per Edit/Write
              // and a persistent fault would otherwise print on every keystroke's
              // worth of tool calls. Once per distinct message per day is enough to
              // be noticed without becoming noise the user learns to ignore.
              reportOnce(`fts:${err?.message || err}`, `filename search failed: ${err?.message || err}`);
            }
            // Only the MATCH query sits in the throttled catch above. The
            // confirmation below reads `observations`; a fault there is a
            // broken database, not a recall miss, and is recorded as an
            // `error` on every run (`recallFault`) — a throttled warning plus
            // `skipped / nothing to recall` is what a healthy empty graph
            // records, and doctor cannot tell the two apart.
            // As many rows as the window allows means there may be MORE
            // past it that were never fetched at all — recorded below so a
            // resulting "nothing to recall" does not overclaim.
            if (ftsResults.length === CANDIDATE_WINDOW) candidateWindowTruncated = true;
            // Literal confirmation (#358 round 2, and round 3 item 3 for
            // the boundary/path-suffix rules): `entities_fts` is
            // contentless (it can only be MATCHed, never read from), so
            // the text to confirm against comes from `entities.name` and
            // every one of the entity's `observations.content` — not just
            // the first observation the display snippet below uses, since
            // the file name may be named in a later one.
            try {
              const getAllObs = db.prepare('SELECT content FROM observations WHERE entity_id = ?');
              for (const r of ftsResults) {
                if (!isTrustedForAutoContext(r.metadata)) continue;
                if (results.some(existing => existing.id === r.id)) continue;
                const candidateText = [r.name, ...getAllObs.all(r.id).map((o) => o.content)].join('\n');
                if (!containsFileNameLiterally(candidateText, confirmNeedle, editedPath)) continue;
                results.push(r);
              }
            } catch (err) {
              recallFault = err;
            }
          }

          // #358 round 4 finding 1: the truncation fact belongs on the
          // outcome whenever the window filled AND fewer than MAX_RESULTS
          // were confirmed overall — not only when NOTHING was confirmed.
          // 1-2 genuinely-confirmed memories can still be hiding a 3rd (or a
          // better-ranked) one past the window; injecting them without the
          // caveat is the same overclaim `nothingToRecall` made, just
          // wearing a happier outcome. Finalised here, once, after both
          // strategies have had their say, so `results.length` is the true
          // final count (Strategy 1's exact-tag hits count too — if it alone
          // already filled MAX_RESULTS, Strategy 2 never ran and this stays
          // false, correctly).
          candidateWindowTruncated = candidateWindowTruncated && results.length < MAX_RESULTS;

          if (!recallFault && results.length > 0) {
            try {
              // Fetch first observation for each result
              const getObs = db.prepare(
                'SELECT content FROM observations WHERE entity_id = ? ORDER BY id ASC LIMIT 1'
              );

              const snippetLines = [`Relevant memories for ${fileName}:`];
              for (const r of results.slice(0, MAX_RESULTS)) {
                const obs = getObs.get(r.id);
                const snippet = obs ? obs.content.slice(0, 120) : '';
                snippetLines.push(snippet
                  ? `• ${r.name} (${r.type}): ${snippet}`
                  : `• ${r.name} (${r.type})`
                );
              }
              recallLines.push(...snippetLines);
            } catch (err) {
              recallFault = err;
            }
          }

          // Record as seen either way (avoid re-querying a no-result file) —
          // but not after a fault: that run looked at nothing, and marking
          // the file seen would switch recall off for the whole session.
          if (!recallFault) recordSeen(seenFiles, fileKey);
        }
      }
    } finally {
      db.close();
    }

    if (recallFault) {
      // Same trace and outcome the outer handler gives any other fault, on
      // every run — but the guard half, already evaluated, is still emitted.
      try { process.stderr.write(`[memesh pre-edit-recall] ${recallFault?.message || recallFault}\n`); } catch {}
      if (guardMatches.length > 0) {
        const faultToolLabel = data.tool_name === 'Write' ? 'Write' : 'Edit';
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: buildReferenceContext(guardWarningLines(guardMatches, faultToolLabel)),
          },
        }));
      }
      record('error', hookErrorReason(recallFault));
      // Like the normal output path below, a run that wrote to stdout ends
      // by returning, not `process.exit`, so the write is never cut short.
      if (guardMatches.length === 0) pass();
      // Last, as below: the counter must never stand between a match and
      // its warning.
      else recordGuardFires(dbPath, guardMatches.map((g) => g.lessonId));
      return;
    }

    if (guardMatches.length === 0 && recallLines.length === 0) {
      // #358 round 3 item 2: "nothing to recall" is only honest when the
      // search actually covered everything there was to look at. When
      // Strategy 2's candidate window filled up, say so instead — the
      // review's reproduction: 9+ decoys failing confirmation hid a 10th,
      // genuinely-matching row, and the old reason claimed there was
      // nothing when there was something this run never got to examine.
      record('skipped', candidateWindowTruncated
        ? SKIP_REASONS.candidateWindowTruncated
        : SKIP_REASONS.nothingToRecall);
      return pass();
    }

    // #358 round 4 finding 1: the SAME truncation caveat belongs on a
    // `notified` outcome too — 1 or 2 confirmed memories injected while the
    // window was full is not "the search found what there was to find",
    // it is "the search found some of what there might be". Carrying the
    // reason on a non-`skipped` outcome is safe: `isTriggeredRecord`
    // (src/core/capture-liveness.ts) treats any outcome other than
    // `skipped` as triggered regardless of `reason`, and `summarizeOne`'s
    // `notified` branch never reads `r.reason` at all — this cannot be
    // miscounted as a skip or make a healthy hook look silent.
    const notifiedReason = candidateWindowTruncated ? SKIP_REASONS.candidateWindowTruncated : undefined;

    // One fenced block, guards first — the warning about the edit at hand
    // outranks background recall. Both halves are memory content, so both
    // ride the same "background data" fence.
    const toolLabel = data.tool_name === 'Write' ? 'Write' : 'Edit';
    const lines = guardMatches.length > 0
      ? [...guardWarningLines(guardMatches, toolLabel), ...(recallLines.length > 0 ? ['', ...recallLines] : [])]
      : recallLines;

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: buildReferenceContext(lines),
      },
    }));
    // A recall hook produces an INJECTION, so it records `notified`, not
    // `wrote`: doctor's `writes` answers "is memory capture still alive",
    // and recalling a memory is not storing one.
    //
    // Not "this hook writes nothing" — it does, and the distinction is the
    // whole point of the outcome. `recordGuardFires` above issues an
    // `UPDATE entities SET metadata = json_set(… '$.guard.fires' …)`
    // (_shared.js), bumping a counter on a memory that already exists. That
    // is a write to the database and NOT a write of a memory, which is what
    // `writes` counts. guard-check.js does the same thing for the same
    // reason. A run of skips here is normal; a long run of them on a machine
    // that edits files daily is not (#327).
    record('notified', notifiedReason, `injected:${guardMatches.length}g+${recallLines.length}r`);
    // The fire counter is written LAST. It opens its own writable handle and
    // waits on the database's write lock; ahead of the output, another
    // writer holding that lock kept the process waiting until the host's
    // timeout killed it, and the warning it had already matched was never
    // printed.
    if (guardMatches.length > 0) {
      recordGuardFires(dbPath, guardMatches.map((g) => g.lessonId));
    }
  } catch (err) {
    // Never crash Claude Code, but trace — peer hooks (post-commit,
    // pre-compact, session-summary) all stderr-trace their outer
    // catches. Without a trace here, a typo in any prepare statement
    // would silently break continuous recall on every Edit/Write
    // tool call indefinitely.
    try { process.stderr.write(`[memesh pre-edit-recall] ${err?.message || err}\n`); } catch {}
    record('error', hookErrorReason(err));
    pass();
  }
});

function pass() {
  // Empty output = no additional context
  process.exit(0);
}

/**
 * Write a warning to stderr at most once per distinct message per day.
 *
 * A hook that says nothing when it breaks is this project's signature failure;
 * a hook that says the same thing on every tool call is noise the user filters
 * out, which ends in the same place. The marker file lives beside the throttle
 * file this hook already maintains.
 */
function reportOnce(key, message) {
  try {
    const markerPath = join(memeshDir, 'hook-warnings.json');
    let seen = {};
    try {
      if (existsSync(markerPath)) seen = JSON.parse(readFileSync(markerPath, 'utf8')) || {};
    } catch { seen = {}; }

    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (typeof seen[key] === 'number' && now - seen[key] < DAY) return;

    seen[key] = now;
    // Bound the file: keep the 20 most recent keys.
    const trimmed = Object.fromEntries(
      Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 20)
    );
    ensurePrivateDir(memeshDir);
    writePrivateJson(markerPath, trimmed);
    process.stderr.write(`[memesh pre-edit-recall] ${message}\n`);
  } catch { /* a warning must never break the user's edit */ }
}

/**
 * Resolve `dir` to its real (symlink-free) form, walking up to the nearest
 * EXISTING ancestor first — a `Write` may target a directory that does not
 * exist yet, and `realpathSync` throws on a missing path. Using an ancestor
 * rather than `dir` itself is fine for project identity: any directory
 * inside a repository resolves to the same repo root.
 *
 * Returns `{ dir, tail }`: `dir` is that resolved ancestor, `tail` the
 * components the walk dropped to reach it ('' when `dir` itself exists), so
 * the caller can rebuild the file's OWN directory instead of mistaking the
 * ancestor for it.
 *
 * On any error (a path `realpathSync` still can't resolve, a walk that
 * reaches the filesystem root with nothing existing) returns the original
 * `dir` with an empty tail.
 */
function realpathNearestExisting(dir) {
  let candidate = dir;
  const dropped = [];
  // Bounded, not `while (true)`: a pathological input (e.g. a cyclic
  // symlink dirname loop, which should not happen but must not hang a
  // PreToolUse hook if it somehow does) must still terminate.
  for (let i = 0; i < 64; i++) {
    if (existsSync(candidate)) {
      try {
        return { dir: realpathSync(candidate), tail: dropped.length ? join(...dropped) : '' };
      } catch {
        return { dir, tail: '' };
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) break; // reached the filesystem root
    dropped.unshift(basename(candidate));
    candidate = parent;
  }
  return { dir, tail: '' };
}

function recordSeen(seenFiles, fileKey) {
  try {
    seenFiles.push(fileKey);
    // Cap at 100 to prevent unbounded growth
    if (seenFiles.length > 100) seenFiles = seenFiles.slice(-50);
    ensurePrivateDir(memeshDir);
    writePrivateJson(THROTTLE_FILE, seenFiles);
  } catch {
    // Non-critical
  }
}
