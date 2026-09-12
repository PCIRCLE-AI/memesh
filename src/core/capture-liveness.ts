/**
 * Capture liveness — the pure verdict layer (issue #327).
 *
 * The automatic memory layer could go quiet without saying so. Every capture
 * hook exits 0 on its skip paths, and `memesh doctor` checked that hooks were
 * INSTALLED, not that they had WRITTEN anything lately. Measured on the
 * owner's graph: 28–94 `commit` entities a day for eight days, then zero for
 * two — the cause was usage (#321: `git commit -q` prints no line for the
 * output-matching hook to see), but for two days a broken hook and a quiet
 * one looked identical.
 *
 * So each hook now leaves a RECORD on every exit path, and this module turns
 * those records into a verdict. It is deliberately a runtime-LEAF module —
 * node builtins only, and in fact no imports at all — because
 * `scripts/generate-hook-core.mjs` copies its compiled JS next to the hooks:
 * SessionStart must reach the same verdict `memesh doctor` reaches, and a
 * hook cannot import `src/`. Reading and writing the file is the CALLER's
 * job (doctor uses `fs`, the hook uses the shared writer); everything here
 * takes data in and returns data out, so both sides share one definition of
 * what "gone quiet" means.
 */

/**
 * What a hook did on one exit path.
 *
 * `wrote` means a MEMORY was written — that is the whole point of the kind,
 * because `writes` is the numerator of the signal `memesh doctor` uses to
 * answer "is memory capture still alive". Six hooks were recording `wrote`
 * for something that never touches the graph, and each one's own comment
 * said so: guard-check's is a guard-fire counter, user-prompt-intent's and
 * session-start's are the context they injected, decision-nudge's and
 * pre-edit-recall's and remember-nudge's are a line they printed. So the
 * kind is `notified`: the hook ran, it had an effect the user can see, and
 * nothing was saved.
 *
 * A fourth kind rather than excluding remember-nudge by name inside
 * summarizeHookOutcomes: excluding one name would leave the other five
 * counted as memory writes.
 */
export type HookOutcome = 'wrote' | 'skipped' | 'notified' | 'error';

/** Which agent host produced the run. `unknown` is never treated as evidence. */
export type HookHost = 'claude-code' | 'codex' | 'unknown';

export interface HookOutcomeRecord {
  hook: string;
  at: string;
  host: HookHost;
  outcome: HookOutcome;
  reason?: string;
  entity?: string;
}

export interface HookOutcomeFile {
  hooks: Record<string, HookOutcomeRecord[]>;
}

/**
 * JSONL, and append-only, not a JSON document.
 *
 * The first version of this was a read-modify-write JSON file. That loses
 * records by construction here: SessionStart, UserPromptSubmit and a
 * PreToolUse hook can all fire inside the same second, each reads the file,
 * each appends its own record to what it read, and the last writer wins —
 * so exactly the concurrency that indicates a busy session is the
 * concurrency that erases the evidence of it. One `O_APPEND` write of one
 * line has no read step to lose, and the OS orders the writes.
 *
 * The cost is a torn last line when a host timeout kills a hook mid-write:
 * the torn line has no trailing newline, so the next append joins onto it and
 * two records are lost rather than one. That is still a cost worth paying,
 * and the reader drops unparseable lines instead of failing: two lost
 * records beat a lost history.
 */
export const HOOK_OUTCOMES_FILENAME = 'hook-outcomes.jsonl';

/**
 * Records kept per hook: this is BOTH the summarising window and the
 * rotation bound. Bounded because the file is read on every SessionStart.
 *
 * As a rotation bound it must be per-hook, not per-file: a whole-file bound
 * would let the loud hooks — post-commit and guard-check fire twice on every
 * Bash call — push the quiet ones out of the window entirely, and the hook
 * that goes silent in the tail is exactly the one a liveness detector exists
 * to keep watching (session-summary is the FAIL-eligible hook and the
 * lowest-frequency one).
 */
export const HOOK_OUTCOMES_PER_HOOK = 20;

/**
 * Not-triggered records kept per hook, ON TOP of the HOOK_OUTCOMES_PER_HOOK
 * triggered ones — the window is bucketed, not one queue.
 *
 * One queue lost the evidence it exists to keep: post-commit records a
 * "not a git commit command" skip on EVERY Bash call, so with four or more
 * Bash calls between commits a 20-record window never held the 5 triggered
 * runs `silent` needs, and ten commits that saved nothing read as PASS.
 * Bucketed, not-triggered records can never push triggered ones out; a few
 * are kept only so `--json` still shows the hook is running.
 */
export const HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK = 5;

/**
 * Which records the per-hook window keeps: walking from the newest, the last
 * `maxTriggered` triggered and `maxNotTriggered` not-triggered records of
 * each hook. ONE definition, used by the reader and by rotation, so the file
 * never drops a record the reader would have counted.
 */
function windowKeep(
  entries: ReadonlyArray<{ hook: string; triggered: boolean }>,
  maxTriggered: number,
  maxNotTriggered: number,
): boolean[] {
  const keep = new Array<boolean>(entries.length).fill(false);
  const seen = new Map<string, { t: number; n: number }>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const { hook, triggered } = entries[i];
    const counts = seen.get(hook) ?? { t: 0, n: 0 };
    seen.set(hook, counts);
    if (triggered) {
      if (++counts.t <= maxTriggered) keep[i] = true;
    } else if (++counts.n <= maxNotTriggered) {
      keep[i] = true;
    }
  }
  return keep;
}

/**
 * True unless the record is a skip whose reason says the trigger did not
 * apply. `wrote`, `notified` and `error` are all triggered runs: the hook
 * fired and did something.
 */
export function isTriggeredRecord(record: Pick<HookOutcomeRecord, 'hook' | 'outcome' | 'reason'>): boolean {
  if (record.outcome !== 'skipped' || record.reason === undefined) return true;
  return !(NOT_TRIGGERED_SKIP_REASONS[record.hook] ?? []).includes(record.reason);
}

interface HookOutcomeEntry {
  hook: string;
  triggered: boolean;
  record: HookOutcomeRecord;
  /** The original line, so rotation can re-emit exactly what it read. */
  line: string;
}

/**
 * Every parseable line of the history, with the `windowKeep` inputs derived
 * from it. ONE definition of "read this file", shared by the reader
 * (parseHookOutcomes) and by rotation (trimHookOutcomeLines), so the two can
 * never disagree about which lines exist. A line that does not parse — a torn
 * last line an interrupted hook left behind, or a record naming a hook memesh
 * does not ship — is dropped by both.
 */
function readHookOutcomeLines(raw: string): HookOutcomeEntry[] {
  const entries: HookOutcomeEntry[] = [];
  for (const line of raw.split('\n')) {
    const record = parseHookOutcomeLine(line);
    if (record) entries.push({ hook: record.hook, triggered: isTriggeredRecord(record), record, line });
  }
  return entries;
}

/**
 * Rotate lazily: counting lines on every append would mean reading the file
 * back on the hot path, which is the read step O_APPEND exists to remove. A
 * `stat` is cheap, so SIZE is the trigger and the trim is exact.
 *
 * 64 KiB is a comfortable multiple of the per-hook window for every hook
 * that records (8 hooks × (20 triggered + 5 not-triggered) records), with
 * room for long reason strings.
 * The bound is a ceiling, not a target — a file slightly under it still
 * rotates when the size crosses, and the trim is exact when it does.
 */
export const HOOK_OUTCOMES_ROTATE_BYTES = 64 * 1024;

/** Serialise one record as a single JSONL line, newline included. */
export function serializeHookOutcome(record: HookOutcomeRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Keep each hook's window (the last `max` triggered records plus the last
 * HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK not-triggered ones), in their
 * original order. Used by rotation; pure so the bound is testable without a
 * filesystem. Unparseable lines are dropped by readHookOutcomeLines, so they
 * are not counted toward any hook's window.
 */
export function trimHookOutcomeLines(
  raw: string,
  max: number = HOOK_OUTCOMES_PER_HOOK,
  maxBytes: number = HOOK_OUTCOMES_ROTATE_BYTES,
): string {
  const records = readHookOutcomeLines(raw);
  // The same window the reader keeps, re-emitted in original order —
  // rotation must preserve tail ordering.
  const keep = windowKeep(records, max, HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK);
  let kept = records.filter((_, i) => keep[i]).map((r) => r.line);
  // The per-hook trim is exact, but it is not a size bound: 8 hooks × 20
  // records of long reasons can still sit above the rotation threshold, and
  // then EVERY append would re-read and rewrite the whole file. When the
  // trimmed text is still over `maxBytes`, keep only the newest lines that
  // fit — a smaller window beats a rewrite on every hook run.
  let bytes = kept.reduce((n, line) => n + utf8Length(line) + 1, 0);
  if (bytes > maxBytes) {
    // Half the threshold, not all of it: landing just under the bound would
    // put the next append straight back over it. A single line longer than
    // that budget is dropped FIRST — otherwise it would stop the walk below
    // at the newest line and wipe the whole history for one bad record.
    const budget = maxBytes / 2;
    const fit: string[] = [];
    bytes = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      const size = utf8Length(kept[i]) + 1;
      if (size > budget) continue;
      if (bytes + size > budget) break;
      fit.push(kept[i]);
      bytes += size;
    }
    kept = fit.reverse();
  }
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** UTF-8 byte length without Buffer — this module has no imports on purpose. */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * A hook that ran this many times inside its recorded window and never wrote
 * is worth a sentence. Below it, silence is ordinary — a couple of Bash calls
 * that were not commits prove nothing.
 */
export const SILENT_HOOK_MIN_RUNS = 5;

/**
 * Every hook that records an outcome. Doctor reports a row for each, and a
 * record naming any other hook is rejected on read (see parseHookOutcomeLine).
 */
export const CAPTURE_HOOKS = [
  'post-commit',
  'session-summary',
  'pre-compact',
  'pre-edit-recall',
  'user-prompt-intent',
  'decision-nudge',
  'guard-check',
  'session-start',
  // #324: the two halves of Stop-side note work, recorded by the Stop hook
  // (scripts/hooks/_stop-notes.js) under their own names so their skips do
  // not dilute session-summary's window. Neither is SILENT_ELIGIBLE: most
  // Stops correctly ingest nothing (no note changed) and nudge nothing (the
  // turn made no decision), so "ran and did not write" is their normal state.
  'note-ingest',
  'remember-nudge',
] as const;

/**
 * The FAIL-eligible subset, and why it is ONE hook.
 *
 * A FAIL has to mean "this should have happened and did not". Only
 * session-summary's trigger is guaranteed: every session ends. post-commit
 * fires on a commit and pre-compact on a compaction, and a user who makes no
 * commits through the agent for a fortnight is not broken — reading their
 * silence as death would put a permanent unfixable red on an install that
 * works. Their silence caps at the PASS_WITH_CONCERNS the run counts
 * produce, which is the honest verdict: worth a look, not a diagnosis.
 */
export const FAIL_ELIGIBLE_HOOKS = ['session-summary'] as const;

/**
 * The hooks whose silence can mean anything, and why it is these three.
 *
 * "Ran N times and wrote nothing" is only a signal when running implies a
 * write is due. That holds for post-commit (a commit happened), pre-compact
 * (a compaction happened) and session-summary (a session ended). It does NOT
 * hold for guard-check and post-commit's PreToolUse/PostToolUse siblings,
 * which fire on every Bash call and skip almost every one of them BY DESIGN,
 * or for user-prompt-intent, which fires on every prompt and writes only
 * when a prompt carries a remember intent. Counting those made a default
 * install PASS_WITH_CONCERNS with a daily banner about a hook doing exactly
 * its job.
 */
export const SILENT_ELIGIBLE_HOOKS = ['post-commit', 'session-summary', 'pre-compact'] as const;

/**
 * Skip reasons shared between the hooks that record them and the verdict
 * that classifies them. Named constants rather than repeated literals: the
 * classification below keys on these strings, and a reworded literal in a
 * hook would quietly move a skip from "not triggered" back to "silent" with
 * nothing going red.
 */
export const SKIP_REASONS = {
  /** post-commit: the Bash call was not a git commit at all. */
  notBash: 'not a Bash tool call',
  notGitCommit: 'not a git commit command',
  /** post-commit: a git commit DID run and no commit line came back — #321. */
  commitLineMissing: 'a git commit ran but printed no commit line',
  /** LEGACY (#322), no longer written — see NOT_TRIGGERED_SKIP_REASONS below. */
  alreadyCaptured: 'this session was already captured',
  // Every other skip reason a hook records. They live HERE, not as literals
  // in the hooks, because doctor quotes only reasons it knows (see
  // renderableSkipReason) and the audit gate refuses a literal skip reason
  // in a hook — so a new reason cannot ship without joining this list.
  payloadTooLarge: 'payload exceeded the stdin byte cap',
  toolNameAbsent: 'tool_name absent in payload',
  notDecisionTool: 'not a decision-shaped tool call',
  noSessionId: 'no usable session_id in the payload',
  alreadyNudged: 'already nudged for this tool in this session',
  noBashCommand: 'no Bash command in the payload',
  noDatabaseForGuards: 'no database yet — nothing to guard against',
  noGuardMatched: 'no active guard matched this command',
  autoCaptureOff: 'auto-capture is turned off',
  commitCwdAbsent: 'data.cwd absent — cannot resolve project or repo',
  hashNotACommit: 'the hash is not a commit in this repository',
  noSessionOrTranscript: 'neither session_id nor transcript_path in the payload',
  emptyStdin: 'empty stdin',
  cwdAbsent: 'cwd absent in payload — cannot resolve project',
  notAgenticLoop: 'not an agentic loop',
  transcriptPathAbsent: 'transcript_path absent',
  transcriptGone: 'the transcript file named by the payload is gone',
  tooLittleActivity: 'too little activity in the session to be worth saving',
  /**
   * session-summary: enough activity to clear tooLittleActivity (3+ tool
   * calls) but none of it fit a capture rule — no file edited, and fewer
   * than 20 calls total (Rule 3's heavy-session bar). A pure read/analysis
   * session lands here. Before this reason existed, the hook fell through
   * to `record('wrote', ...)` with zero entities actually written — every
   * run of this shape claimed a write that never happened.
   */
  noRuleMatched: 'no rule matched (no edited file and fewer than 20 tool calls)',
  /**
   * session-summary: a rule DID match (a file was edited, or the heavy-
   * session bar was crossed), but every entity it targeted had been
   * `forget`-archived, so `replace` left all of them untouched. Distinct
   * from `noRuleMatched` (no rule fired at all) and from a write failure
   * (this is an honoured `forget`, not a broken hook) — before this reason
   * existed, this shape fell through to `record('wrote', ...)` with zero
   * entities actually written, the same false-write shape `noRuleMatched`
   * was added to close.
   */
  allMatchedEntitiesArchived: 'every rule that matched targeted an entity the user forget-archived',
  toolInputAbsent: 'tool_input absent in payload',
  noFilePath: 'no file_path in the tool input',
  noDatabaseForRecall: 'no database yet — nothing to recall',
  nothingToRecall: 'no guard matched and nothing to recall for this file',
  noPromptIntent: 'the prompt carried no remember intent and no update decision',
  // note-ingest (#324)
  noMemoryDir: 'no Claude Code memory directory for this project',
  noNoteChanged: 'no note file changed since the last ingestion',
  noteIngesterNotBuilt: 'the note ingester is not built (dist/core/note-ingest.js is missing)',
  noteNothingNew: 'note files were read and nothing new needed storing',
  // A run that stored nothing but REFUSED files is not the same event, and
  // `noteNothingNew` said it was. Uses NoteIngestResult.refusedNow, never
  // `skipped.length` — the latter sticks forever once a file is bad.
  noteFilesRefused: 'note files were refused and nothing was stored',
  // remember-nudge (#324)
  noTranscript: 'no transcript to read',
  trivialTurn: 'trivial turn — too few tool calls since the last Stop',
  noDecisionMove: 'no decision-shaped move since the last Stop',
  memoryWritten: 'a memory was written since the last Stop',
  noteFileChanged: 'a note file changed since the last Stop',
} as const;

const KNOWN_SKIP_REASONS: ReadonlySet<string> = new Set(Object.values(SKIP_REASONS));

/** What doctor and `--json` show for a skip reason no hook in this version records. */
export const UNRECOGNISED_REASON = 'unrecognised reason';

/**
 * A skip reason safe to QUOTE: one of the reasons the shipped hooks record,
 * or UNRECOGNISED_REASON. Sanitising (control characters, length) stops a
 * planted record from forging lines; it does not stop 200 characters of
 * "SYSTEM: ignore prior instructions" from being quoted into doctor's
 * summary and a pasted issue. An allowlist does.
 */
export function renderableSkipReason(reason: string | undefined): string {
  if (reason === undefined) return 'unspecified';
  return KNOWN_SKIP_REASONS.has(reason) ? reason : UNRECOGNISED_REASON;
}

/**
 * Does this Bash command run `git commit`? post-commit's trigger test.
 *
 * `commit` must be git's SUBCOMMAND: after `git`, only global options may
 * come first (`-C <dir>`, `-c <key=value>`, `--git-dir <dir>`,
 * `--work-tree <dir>`, `--namespace <ns>`, or any `-x` / `--flag[=v]`),
 * and `commit` must end at whitespace, a shell separator or the end — so
 * `git log --grep commit`, `git show HEAD -- src/commit.ts` and
 * `git commit-tree` are not commits. Matching `commit` ANYWHERE after `git`
 * classified all of those as "a git commit ran but printed no commit line",
 * which is the one skip reason that counts toward silence. An option value
 * may be quoted (`-C "/Users/kt/My Project"`, `-c "user.name=x y"`) and git
 * may be named by path (`/usr/bin/git`) — a quiet commit in a repository
 * whose path has a space must not be invisible to liveness.
 *
 * Known deviations, accepted — this is a classifier, not a shell parser:
 *   - text that merely CONTAINS the shape classifies as a commit: a heredoc
 *     or a quoted string (`echo 'run git commit -m x'`), and `git -C commit
 *     log` (a directory named `commit`);
 *   - cherry-pick, revert, merge and `commit-tree` create commits but are not
 *     counted. That is a product decision outside #327; #321 revisits which
 *     commit-creating commands post-commit should capture.
 */
export function isGitCommitCommand(command: string): boolean {
  // A token walk, not one regular expression: the command text is whatever
  // the agent ran, and a single pattern with overlapping alternatives
  // ("any -flag" vs "-C <value>", "quoted" vs "\S+") backtracks
  // exponentially on a crafted string — inside a hook with a timeout. Every
  // character is visited a bounded number of times here.
  const start = /(?:^|[\s;&|(`/])git(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(command)) !== null) {
    const walk = commitFollowsGit(command, m.index + m[0].length);
    if (walk.commit) return true;
    // Resume after what this invocation consumed; a `git` inside its
    // option values is not a new command.
    if (walk.end > start.lastIndex) start.lastIndex = walk.end;
  }
  return false;
}

const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const COMMIT_END = /[\s;&|)`]/;

/** From just after `git`: skip global options, then is the subcommand `commit`? */
function commitFollowsGit(s: string, i: number): { commit: boolean; end: number } {
  for (;;) {
    const afterSpace = skipSpace(s, i);
    if (afterSpace === i) return { commit: false, end: i };
    i = afterSpace;
    if (s.startsWith('commit', i)) {
      const next = s[i + 6];
      return { commit: next === undefined || COMMIT_END.test(next), end: i + 6 };
    }
    if (s[i] !== '-') return { commit: false, end: i };
    const optionEnd = tokenEnd(s, i);
    const option = s.slice(i, optionEnd);
    i = optionEnd;
    if (VALUE_OPTIONS.has(option)) {
      const valueStart = skipSpace(s, i);
      if (valueStart === i || valueStart >= s.length) return { commit: false, end: valueStart };
      i = valueEnd(s, valueStart);
    }
  }
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function tokenEnd(s: string, i: number): number {
  while (i < s.length && !/\s/.test(s[i])) i++;
  return i;
}

/** A quoted value ends at its closing quote; an unquoted one at whitespace. */
function valueEnd(s: string, i: number): number {
  const quote = s[i];
  if (quote === '"' || quote === "'") {
    const close = s.indexOf(quote, i + 1);
    return close === -1 ? s.length : close + 1;
  }
  return tokenEnd(s, i);
}

/**
 * Skips that mean the hook's trigger did not apply, per hook. They are not
 * counted as runs toward `silent`: a post-commit run on `ls` says nothing
 * about whether commits are captured.
 *
 * `session-summary`'s entry is LEGACY (#322): the hook used to skip every
 * Stop after a session's first ("already captured" — a write happened, it is
 * just older than the window), because `remember`'s append semantics had no
 * other way to avoid restating the same sentences every turn. `replace` mode
 * removed the need to skip — session-summary now restates its three
 * `session-<id>-*` entities on every Stop instead — so the hook stopped
 * writing this reason. It is kept here only so a record from BEFORE this
 * upgrade still classifies as not-triggered instead of ageing into a false
 * "silent" verdict. Removable once no installation's outcome window can
 * still hold a pre-#322 record — that happens on its own, a few releases
 * out, once every live install has had ~20 Stops since upgrading.
 *
 * Deliberately NOT here: post-commit's commit-line-missing skip (the #321
 * shape — a commit happened and nothing was saved) and session-summary's
 * low-signal skips, which are real decisions about a real ending session.
 *
 * Known consequence, accepted: "too little activity in the session to be
 * worth saving" is recorded per Stop, i.e. per TURN, so a pure question-and-
 * answer day (five turns, no tool calls) can reach the silent threshold and
 * produce a banner. Classifying it as not-triggered would also hide a Stop
 * hook whose activity count broke, which is the worse error. `noRuleMatched`
 * (#322) widens this the same way and for the same reason: five-plus Stops
 * each with real activity (3-19 tool calls) but no file edit and no heavy-
 * session threshold reached can also produce the banner. In practice this
 * needs several short, edit-free sessions inside one window — a single long
 * session that crosses 20 tool calls writes via Rule 3 on the way — so it is
 * a narrower door than the one above, not a new kind of false alarm.
 */
export const NOT_TRIGGERED_SKIP_REASONS: Readonly<Record<string, readonly string[]>> = {
  'post-commit': [SKIP_REASONS.notBash, SKIP_REASONS.notGitCommit],
  'session-summary': [SKIP_REASONS.alreadyCaptured],
  // #324: the Stop-side pair. Both fire on EVERY Stop, i.e. every turn, and
  // both correctly do nothing on most of them — a turn that edited no note
  // file, and a turn that made no decision. Counted as runs they filled the
  // whole 20-record window within a day and evicted the hook's real `wrote`,
  // so doctor reported a hook that had never written anything. That is the
  // post-commit incident above, repeated.
  //
  // Deliberately NOT listed, and each for a reason:
  //   - noteIngesterNotBuilt / noTranscript: a broken install and a missing
  //     transcript are defects wearing a skip's clothes. They must keep
  //     counting, or the one shape worth seeing becomes invisible.
  //   - noMemoryDir: `claudeMemoryDir` collapses EACCES into "no directory"
  //     (#324 H8), so this reason can hide a permissions failure.
  //   - noteNothingNew: the files WERE read and a decision was made about
  //     them. Same stance as session-summary's low-signal skips.
  'note-ingest': [SKIP_REASONS.noNoteChanged],
  'remember-nudge': [SKIP_REASONS.trivialTurn, SKIP_REASONS.noDecisionMove],
};

/**
 * Recording hooks that deliberately have no not-triggered skip reasons.
 *
 * This list exists only so the pairing can be CHECKED. `note-ingest` and
 * `remember-nudge` were added to CAPTURE_HOOKS and to SKIP_REASONS and
 * missed here, and nothing could go red over it: an absent key and a
 * deliberate "this hook has none" are the same absence. Two lists make them
 * different, and tests/core/doctor-capture-liveness.test.ts requires every
 * CAPTURE_HOOKS entry to appear in exactly one of them.
 *
 * A hook belongs here when every skip it records is a real decision about a
 * trigger that DID apply — or, for the fire-on-everything hooks
 * (guard-check, pre-edit-recall, user-prompt-intent, decision-nudge), when
 * its silence is already discounted by leaving it out of
 * SILENT_ELIGIBLE_HOOKS and it writes no memory whose eviction would matter.
 */
export const UNCLASSIFIED_SKIP_HOOKS = [
  'pre-compact',
  'pre-edit-recall',
  'user-prompt-intent',
  'decision-nudge',
  'guard-check',
  'session-start',
] as const;

/**
 * Grace period before "no records at all" is allowed to mean anything. On the
 * first run after an upgrade nobody has a `hook-outcomes.jsonl`, so an
 * ungraced FAIL would fire on every install exactly once, for a reason that
 * is not a defect. Mirrors the `hook_runs_since` grace the heartbeat check
 * already uses.
 */
export const NEVER_RAN_GRACE_HOURS = 72;

/**
 * Parse the JSONL history into per-hook windows.
 *
 * Every line is independent, so a line that does not parse — the torn last
 * line an interrupted hook leaves behind — is DROPPED, not fatal. That is
 * the whole reason the format is line-oriented: one lost record is a cost,
 * a lost history is a blind spot, and the blind spot is what this file
 * exists to close.
 *
 * Each hook keeps its last `limit` TRIGGERED records plus its last
 * HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK not-triggered ones (see windowKeep),
 * so a caller's window does not grow with the file and a flood of
 * not-triggered skips cannot push the evidence out of it.
 */
export function parseHookOutcomes(
  raw: string | null | undefined,
  limit: number = HOOK_OUTCOMES_PER_HOOK,
): HookOutcomeFile {
  if (!raw) return { hooks: {} };
  const entries = readHookOutcomeLines(raw);
  const keep = windowKeep(entries, limit, HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK);
  const hooks: Record<string, HookOutcomeRecord[]> = {};
  entries.forEach(({ hook, record }, i) => {
    if (!keep[i]) return;
    (hooks[hook] ?? (hooks[hook] = [])).push(record);
  });
  return { hooks };
}

/** One JSONL line to a record, or null when it is torn, blank, or foreign. */
export function parseHookOutcomeLine(line: string): HookOutcomeRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  // Only hooks memesh ships. MEMESH_DB_PATH may point into a repository or a
  // shared directory, so this file can be PLANTED; its text reaches the
  // doctor report, the SessionStart banner and a pasted issue. A record for
  // a hook that does not exist is foreign by definition.
  if (typeof rec.hook !== 'string' || !(CAPTURE_HOOKS as readonly string[]).includes(rec.hook)) return null;
  if (typeof rec.at !== 'string') return null;
  // An outcome this version does not know discards the WHOLE record — which
  // is why `notified` has to be readable before any hook emits it. Records
  // written by older versions carry only wrote/skipped/error and keep
  // reading exactly as they did.
  if (rec.outcome !== 'wrote' && rec.outcome !== 'skipped'
    && rec.outcome !== 'notified' && rec.outcome !== 'error') return null;
  const record: HookOutcomeRecord = {
    hook: rec.hook,
    at: rec.at,
    host: rec.host === 'claude-code' || rec.host === 'codex' ? rec.host : 'unknown',
    outcome: rec.outcome,
  };
  const reason = typeof rec.reason === 'string' ? sanitizeRecordText(rec.reason) : '';
  if (reason) record.reason = reason;
  const entity = typeof rec.entity === 'string' ? sanitizeRecordText(rec.entity) : '';
  if (entity) record.entity = entity;
  return record;
}

/** Longest reason/entity text a record may carry into a rendered sentence. */
export const RECORD_TEXT_MAX = 200;

/**
 * Make record text safe to render. The writer already caps and redacts, but
 * the threat here is a file the writer never touched: control characters and
 * line breaks are removed so a planted reason cannot forge extra lines in
 * the banner or the report, and the length is capped so it cannot bury them.
 */
export function sanitizeRecordText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, RECORD_TEXT_MAX);
}

export interface HookLivenessSummary {
  hook: string;
  runs: number;
  /**
   * Runs where the hook's trigger applied — `runs` minus the skips listed in
   * NOT_TRIGGERED_SKIP_REASONS. This is the count `silent` and every
   * rendered "ran N times" sentence use, so doctor and the banner quote one
   * figure for one graph.
   */
  triggeredRuns: number;
  writes: number;
  skips: number;
  errors: number;
  lastRunAt: string | null;
  /** The earliest triggered run inside the window — what "since" means. */
  firstTriggeredAt: string | null;
  lastWriteAt: string | null;
  lastEntity: string | null;
  /**
   * Runs that told the user something and saved nothing. Kept OUT of
   * `writes`, `lastWriteAt` and `lastEntity`: a nudge is evidence the hook is
   * alive, never evidence a memory exists.
   */
  notifies: number;
  lastNotifiedAt: string | null;
  lastSkipReason: string | null;
  dominantSkipReason: string | null;
  dominantSkipCount: number;
  hosts: HookHost[];
  /**
   * A SILENT_ELIGIBLE_HOOKS hook whose trigger applied at least
   * SILENT_HOOK_MIN_RUNS times in the window, and which wrote nothing.
   */
  silent: boolean;
}

/** One summary per hook that has records, ordered by the canonical hook list. */
export function summarizeHookOutcomes(file: HookOutcomeFile): HookLivenessSummary[] {
  const order = [...CAPTURE_HOOKS] as string[];
  const names = Object.keys(file.hooks).sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== bi) return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    return a.localeCompare(b);
  });
  return names.map((hook) => summarizeOne(hook, file.hooks[hook] ?? []));
}

function summarizeOne(hook: string, records: HookOutcomeRecord[]): HookLivenessSummary {
  let writes = 0;
  let skips = 0;
  let errors = 0;
  let lastRunAt: string | null = null;
  let firstTriggeredAt: string | null = null;
  let triggeredRuns = 0;
  let lastWriteAt: string | null = null;
  let lastEntity: string | null = null;
  let notifies = 0;
  let lastNotifiedAt: string | null = null;
  let lastSkipReason: string | null = null;
  const skipCounts = new Map<string, number>();
  const hosts = new Set<HookHost>();
  for (const r of records) {
    hosts.add(r.host);
    if (lastRunAt === null || r.at >= lastRunAt) lastRunAt = r.at;
    const triggered = isTriggeredRecord(r);
    if (triggered) {
      triggeredRuns++;
      if (firstTriggeredAt === null || r.at < firstTriggeredAt) firstTriggeredAt = r.at;
    }
    if (r.outcome === 'wrote') {
      writes++;
      if (lastWriteAt === null || r.at >= lastWriteAt) {
        lastWriteAt = r.at;
        lastEntity = r.entity ?? null;
      }
    } else if (r.outcome === 'notified') {
      // An explicit branch, not a fall-through: the final `else` below is
      // `errors++`, so an unhandled kind would turn every nudge into a
      // doctor error — a new kind going wrong loudly instead of invisibly,
      // but wrong either way.
      notifies++;
      if (lastNotifiedAt === null || r.at >= lastNotifiedAt) lastNotifiedAt = r.at;
    } else if (r.outcome === 'skipped') {
      skips++;
      // Rendered, not raw: these two are what doctor QUOTES (see
      // renderableSkipReason). The raw text never leaves this function.
      lastSkipReason = r.reason === undefined ? null : renderableSkipReason(r.reason);
      // The dominant reason is the one doctor QUOTES as the cause of a
      // silence, so it is drawn from triggered skips only — "not a git
      // commit command" outnumbers everything and explains nothing.
      if (triggered) {
        const key = renderableSkipReason(r.reason);
        skipCounts.set(key, (skipCounts.get(key) ?? 0) + 1);
      }
    } else {
      errors++;
    }
  }
  let dominantSkipReason: string | null = null;
  let dominantSkipCount = 0;
  for (const [reason, count] of skipCounts) {
    if (count > dominantSkipCount) {
      dominantSkipCount = count;
      dominantSkipReason = reason;
    }
  }
  const runs = records.length;
  return {
    hook,
    runs,
    triggeredRuns,
    writes,
    skips,
    errors,
    lastRunAt,
    firstTriggeredAt,
    lastWriteAt,
    lastEntity,
    notifies,
    lastNotifiedAt,
    lastSkipReason,
    dominantSkipReason,
    dominantSkipCount,
    hosts: [...hosts].sort(),
    // `writes === 0` is unchanged, and `notified` deliberately does not
    // rescue a hook from it — a hook that only printed lines HAS written
    // nothing. Safe because no notifying hook is in SILENT_ELIGIBLE_HOOKS
    // (post-commit, session-summary, pre-compact), so this cannot turn the
    // repair into a daily false alarm; the test file pins that pairing.
    silent: (SILENT_ELIGIBLE_HOOKS as readonly string[]).includes(hook)
      && triggeredRuns >= SILENT_HOOK_MIN_RUNS
      && writes === 0,
  };
}

export interface TypeTrend {
  type: string;
  last7: number;
  prev7: number;
  /** Wrote in the previous week and nothing at all in this one. */
  stopped: boolean;
}

export function summarizeTypeTrends(
  rows: Array<{ type: string; last7: number; prev7: number }>,
): TypeTrend[] {
  return rows
    .map((r) => ({ ...r, stopped: r.prev7 > 0 && r.last7 === 0 }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

export type CaptureLivenessStatus = 'PASS' | 'PASS_WITH_CONCERNS' | 'FAIL';

export interface CaptureLivenessInput {
  hooks: HookLivenessSummary[];
  types: TypeTrend[];
  /** Heartbeat hooks that `hook_runs` says never ran. */
  neverRanHooks?: string[];
  /** Hours since outcome/heartbeat tracking could have started, if known. */
  measuringHours?: number | null;
}

export interface CaptureLivenessVerdict {
  status: CaptureLivenessStatus;
  /** The hook whose silence drives a non-PASS verdict, when one does. */
  silentHook: HookLivenessSummary | null;
  /** Types that stopped, when that drives the verdict. */
  stoppedTypes: TypeTrend[];
  /** Heartbeat hooks with neither a record nor a heartbeat, past the grace. */
  deadHooks: string[];
}

/**
 * The verdict both `memesh doctor` and the SessionStart line are computed
 * from. One definition, or the banner and the report would disagree about
 * whether capture is alive — the exact split this issue exists to close.
 */
export function captureLivenessVerdict(input: CaptureLivenessInput): CaptureLivenessVerdict {
  const withRecords = new Set(input.hooks.filter((h) => h.runs > 0).map((h) => h.hook));
  const graceOver =
    input.measuringHours !== null &&
    input.measuringHours !== undefined &&
    input.measuringHours > NEVER_RAN_GRACE_HOURS;
  const deadHooks = graceOver
    ? (input.neverRanHooks ?? []).filter(
      (h) => (FAIL_ELIGIBLE_HOOKS as readonly string[]).includes(h) && !withRecords.has(h),
    ).sort()
    : [];

  // A silent hook is reported by the one with the most triggered runs: it is
  // the one with the most evidence behind the claim, not merely the first
  // alphabetically.
  const silent = input.hooks.filter((h) => h.silent).sort((a, b) => b.triggeredRuns - a.triggeredRuns);
  const stoppedTypes = input.types.filter((t) => t.stopped);

  let status: CaptureLivenessStatus = 'PASS';
  if (deadHooks.length > 0) status = 'FAIL';
  else if (silent.length > 0 || stoppedTypes.length > 0) status = 'PASS_WITH_CONCERNS';

  return { status, silentHook: silent[0] ?? null, stoppedTypes, deadHooks };
}

/**
 * The one SessionStart sentence, or null when there is nothing to say.
 *
 * Suppression after the next successful write needs no second marker: a
 * `wrote` record makes the hook non-silent, the verdict goes back to PASS,
 * and this returns null. Only the once-a-day throttle needs a file.
 */
export function captureLivenessNotice(verdict: CaptureLivenessVerdict): string | null {
  if (verdict.status === 'PASS') return null;
  if (verdict.deadHooks.length > 0) {
    const hook = verdict.deadHooks[0];
    return `memesh: the ${hook} hook has never run — \`memesh doctor\` for the reason`;
  }
  const hook = verdict.silentHook;
  if (hook) {
    const since = (hook.firstTriggeredAt ?? '').slice(0, 10) || 'install';
    return `memesh: ${hook.hook} ran ${hook.triggeredRuns} times since ${since} and wrote nothing — \`memesh doctor\` for the reason`;
  }
  const stopped = verdict.stoppedTypes[0];
  if (stopped) {
    return `memesh: nothing of type ${stopped.type} was captured this week (${stopped.prev7} last week) — \`memesh doctor\` for the reason`;
  }
  return null;
}

/**
 * The post-install / post-upgrade grace for the SessionStart line.
 *
 * A fresh install has no history, and an upgrade replaces the hooks — in
 * both cases the first sessions are exactly when a hook legitimately has a
 * run of skips and no writes yet. Warning there trains the user to ignore
 * the line, which costs more than the two days of silence it exists to
 * catch. The window is three sessions OR 24 hours, whichever ends LATER, so
 * neither a burst of short sessions nor a single long one can shorten it.
 */
export const GRACE_SESSIONS = 3;
export const GRACE_HOURS = 24;

export interface CaptureGraceState {
  /** The version the counter belongs to. A change resets it. */
  version: string;
  /** ISO timestamp of the first session seen on this version. */
  firstSeenAt: string;
  /** Sessions seen on this version, including the current one. */
  sessions: number;
}

export function parseGraceState(raw: string | null | undefined): CaptureGraceState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.version !== 'string' || typeof rec.firstSeenAt !== 'string') return null;
  const sessions = typeof rec.sessions === 'number' && Number.isFinite(rec.sessions) ? rec.sessions : 0;
  return { version: rec.version, firstSeenAt: rec.firstSeenAt, sessions };
}

/** Count this session against the grace, resetting on a version change. */
export function advanceGraceState(
  previous: CaptureGraceState | null,
  version: string,
  nowMs: number,
): CaptureGraceState {
  if (!previous || previous.version !== version) {
    return { version, firstSeenAt: new Date(nowMs).toISOString(), sessions: 1 };
  }
  return { ...previous, sessions: previous.sessions + 1 };
}

/** True while the warning must stay quiet. */
export function graceInEffect(state: CaptureGraceState, nowMs: number): boolean {
  if (state.sessions <= GRACE_SESSIONS) return true;
  const startedMs = Date.parse(state.firstSeenAt);
  // An unparseable timestamp must not silence the warning forever: the
  // session count above is then the whole grace.
  if (!Number.isFinite(startedMs)) return false;
  return nowMs - startedMs < GRACE_HOURS * 60 * 60 * 1000;
}

/**
 * Which agent host a hook payload came from.
 *
 * Pure so both the hook writer and any test can call it. The payload shape is
 * the primary signal — Claude Code sends `transcript_path` / `hook_event_name`,
 * Codex identifies itself in the environment — and `unknown` is returned
 * rather than guessed, because a wrong host label on a liveness record is
 * worse than an absent one (#325/#326 want these figures PER HOST).
 */
export function detectHookHost(
  payload: Record<string, unknown> | null | undefined,
  env: Record<string, string | undefined> = {},
): HookHost {
  if (env.MEMESH_HOOK_HOST === 'claude-code' || env.MEMESH_HOOK_HOST === 'codex') {
    return env.MEMESH_HOOK_HOST;
  }
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_PLUGIN_ROOT) return 'codex';
  if (env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PROJECT_DIR || env.CLAUDECODE) return 'claude-code';
  if (payload && typeof payload === 'object') {
    if (typeof payload.transcript_path === 'string' || typeof payload.hook_event_name === 'string') {
      return 'claude-code';
    }
  }
  return 'unknown';
}
