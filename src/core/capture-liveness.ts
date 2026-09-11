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

export type HookOutcome = 'wrote' | 'skipped' | 'error';

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
 * Rotate lazily: counting lines on every append would mean reading the file
 * back on the hot path, which is the read step O_APPEND exists to remove. A
 * `stat` is cheap, so SIZE is the trigger and the trim is exact.
 *
 * 64 KiB is a comfortable multiple of the per-hook window for every hook
 * that records (8 hooks × 20 records), with room for long reason strings.
 * The bound is a ceiling, not a target — a file slightly under it still
 * rotates when the size crosses, and the trim is exact when it does.
 */
export const HOOK_OUTCOMES_ROTATE_BYTES = 64 * 1024;

/** Serialise one record as a single JSONL line, newline included. */
export function serializeHookOutcome(record: HookOutcomeRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Keep each hook's last `max` records, in their original order. Used by
 * rotation; pure so the bound is testable without a filesystem. A line that
 * does not parse (a torn last line an interrupted hook left behind, or a
 * record naming a hook memesh does not ship) is dropped, not counted toward
 * any hook's window.
 */
export function trimHookOutcomeLines(
  raw: string,
  max: number = HOOK_OUTCOMES_PER_HOOK,
  maxBytes: number = HOOK_OUTCOMES_ROTATE_BYTES,
): string {
  const records: Array<{ hook: string; line: string }> = [];
  for (const line of raw.split('\n')) {
    const record = parseHookOutcomeLine(line);
    if (record) records.push({ hook: record.hook, line });
  }
  // Walk backwards so the newest `max` records of each hook are kept, then
  // re-emit in original order — rotation must preserve tail ordering.
  const keep = new Array<boolean>(records.length).fill(false);
  const seen = new Map<string, number>();
  for (let i = records.length - 1; i >= 0; i--) {
    const hook = records[i].hook;
    const n = (seen.get(hook) ?? 0) + 1;
    seen.set(hook, n);
    if (n <= max) keep[i] = true;
  }
  let kept = records.filter((_, i) => keep[i]).map((r) => r.line);
  // The per-hook trim is exact, but it is not a size bound: 8 hooks × 20
  // records of long reasons can still sit above the rotation threshold, and
  // then EVERY append would re-read and rewrite the whole file. When the
  // trimmed text is still over `maxBytes`, keep only the newest lines that
  // fit — a smaller window beats a rewrite on every hook run.
  let bytes = kept.reduce((n, line) => n + utf8Length(line) + 1, 0);
  if (bytes > maxBytes) {
    const fit: string[] = [];
    bytes = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      const size = utf8Length(kept[i]) + 1;
      // Half the threshold, not all of it: landing just under the bound
      // would put the next append straight back over it.
      if (bytes + size > maxBytes / 2) break;
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
  /** session-summary: this session's capture already landed on an earlier Stop. */
  alreadyCaptured: 'this session was already captured',
} as const;

/**
 * Skips that mean the hook's trigger did not apply, per hook. They are not
 * counted as runs toward `silent`: a post-commit run on `ls` says nothing
 * about whether commits are captured, and session-summary fires on EVERY
 * Stop (every turn), so after one capture per session the rest of the window
 * is "already captured" — a write happened, it is just older than the window.
 *
 * Deliberately NOT here: post-commit's commit-line-missing skip (the #321
 * shape — a commit happened and nothing was saved) and session-summary's
 * low-signal skips, which are real decisions about a real ending session.
 */
export const NOT_TRIGGERED_SKIP_REASONS: Readonly<Record<string, readonly string[]>> = {
  'post-commit': [SKIP_REASONS.notBash, SKIP_REASONS.notGitCommit],
  'session-summary': [SKIP_REASONS.alreadyCaptured],
};

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
 * Only the last HOOK_OUTCOMES_PER_HOOK records per hook are kept, so a
 * caller's window does not grow with the file.
 */
export function parseHookOutcomes(
  raw: string | null | undefined,
  limit: number = HOOK_OUTCOMES_PER_HOOK,
): HookOutcomeFile {
  if (!raw) return { hooks: {} };
  const hooks: Record<string, HookOutcomeRecord[]> = {};
  for (const line of raw.split('\n')) {
    const record = parseHookOutcomeLine(line);
    if (!record) continue;
    const bucket = hooks[record.hook] ?? (hooks[record.hook] = []);
    bucket.push(record);
    if (bucket.length > limit) bucket.shift();
  }
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
  if (rec.outcome !== 'wrote' && rec.outcome !== 'skipped' && rec.outcome !== 'error') return null;
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
  let lastSkipReason: string | null = null;
  const skipCounts = new Map<string, number>();
  const hosts = new Set<HookHost>();
  const notTriggered = NOT_TRIGGERED_SKIP_REASONS[hook] ?? [];
  for (const r of records) {
    hosts.add(r.host);
    if (lastRunAt === null || r.at >= lastRunAt) lastRunAt = r.at;
    const triggered = !(r.outcome === 'skipped' && r.reason !== undefined && notTriggered.includes(r.reason));
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
    } else if (r.outcome === 'skipped') {
      skips++;
      lastSkipReason = r.reason ?? null;
      // The dominant reason is the one doctor QUOTES as the cause of a
      // silence, so it is drawn from triggered skips only — "not a git
      // commit command" outnumbers everything and explains nothing.
      if (triggered) {
        const key = r.reason ?? 'unspecified';
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
    lastSkipReason,
    dominantSkipReason,
    dominantSkipCount,
    hosts: [...hosts].sort(),
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
