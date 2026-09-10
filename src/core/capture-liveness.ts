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
  session_id?: string;
}

export interface HookOutcomeFile {
  version: number;
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
 * The cost is a torn last line when a host timeout kills a hook mid-write.
 * That is a cost worth paying, and the reader drops an unparseable line
 * instead of failing: one lost record beats a lost history.
 */
export const HOOK_OUTCOMES_FILENAME = 'hook-outcomes.jsonl';
export const HOOK_OUTCOMES_VERSION = 1;

/**
 * Records kept per hook when summarising. Bounded because this file is read
 * on every SessionStart, and nothing here needs more than a recent window.
 */
export const HOOK_OUTCOMES_PER_HOOK = 20;

/**
 * Lines kept in the file. Rotation rewrites the file with the last 200 lines
 * when it grows past that — atomically, so a reader sees the old complete
 * file or the new one. 200 is ~10 hooks x the 20-record window each
 * summary uses, so rotation can never drop a record a summary would show.
 */
export const HOOK_OUTCOMES_MAX_LINES = 200;

/**
 * Rotate lazily: checking the line count on every append would mean reading
 * the file back on the hot path, which is the read step O_APPEND exists to
 * remove. A `stat` is cheap, so SIZE is the trigger and the trim is exact.
 *
 * 32 KiB is roughly HOOK_OUTCOMES_MAX_LINES typical records. Records with
 * long reason strings are bigger, so the file can hold fewer lines than the
 * maximum before it rotates — never more than the trim allows, which is the
 * direction that matters: the bound is a ceiling, not a target.
 */
export const HOOK_OUTCOMES_ROTATE_BYTES = 32 * 1024;

/** Serialise one record as a single JSONL line, newline included. */
export function serializeHookOutcome(record: HookOutcomeRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Keep the last `max` complete lines. Used by rotation; pure so the bound is
 * testable without a filesystem.
 */
export function trimHookOutcomeLines(raw: string, max: number = HOOK_OUTCOMES_MAX_LINES): string {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const kept = lines.length > max ? lines.slice(lines.length - max) : lines;
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/**
 * A hook that ran this many times inside its recorded window and never wrote
 * is worth a sentence. Below it, silence is ordinary — a couple of Bash calls
 * that were not commits prove nothing.
 */
export const SILENT_HOOK_MIN_RUNS = 5;

/** Every hook that records an outcome. Doctor reports a row for each. */
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
 * The FAIL-eligible subset, and the reason it is a subset.
 *
 * Only these three stamp `hook_runs` (see `KNOWN_HOOKS` in doctor.ts) — the
 * other five have no heartbeat row BY DESIGN, so "no record AND no heartbeat"
 * is their permanent normal state and would FAIL them forever. A missing
 * record can only be read as death where a second, independent source agrees
 * it never ran.
 */
export const HEARTBEAT_HOOKS = ['post-commit', 'session-summary', 'pre-compact'] as const;

/**
 * Grace period before "no records at all" is allowed to mean anything. On the
 * first run after an upgrade nobody has a `hook-outcomes.json`, so an
 * ungraced FAIL would fire on every install exactly once, for a reason that
 * is not a defect. Mirrors the `hook_runs_since` grace the heartbeat check
 * already uses.
 */
export const NEVER_RAN_GRACE_HOURS = 72;

export function emptyOutcomeFile(): HookOutcomeFile {
  return { version: HOOK_OUTCOMES_VERSION, hooks: {} };
}

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
  if (!raw) return emptyOutcomeFile();
  const hooks: Record<string, HookOutcomeRecord[]> = {};
  for (const line of raw.split('\n')) {
    const record = parseHookOutcomeLine(line);
    if (!record) continue;
    const bucket = hooks[record.hook] ?? (hooks[record.hook] = []);
    bucket.push(record);
    if (bucket.length > limit) bucket.shift();
  }
  return { version: HOOK_OUTCOMES_VERSION, hooks };
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
  if (typeof rec.hook !== 'string' || !rec.hook) return null;
  if (typeof rec.at !== 'string') return null;
  if (rec.outcome !== 'wrote' && rec.outcome !== 'skipped' && rec.outcome !== 'error') return null;
  const record: HookOutcomeRecord = {
    hook: rec.hook,
    at: rec.at,
    host: rec.host === 'claude-code' || rec.host === 'codex' ? rec.host : 'unknown',
    outcome: rec.outcome,
  };
  if (typeof rec.reason === 'string') record.reason = rec.reason;
  if (typeof rec.entity === 'string') record.entity = rec.entity;
  if (typeof rec.session_id === 'string') record.session_id = rec.session_id;
  return record;
}

export interface HookLivenessSummary {
  hook: string;
  runs: number;
  writes: number;
  skips: number;
  errors: number;
  lastRunAt: string | null;
  lastWriteAt: string | null;
  lastEntity: string | null;
  lastSkipReason: string | null;
  dominantSkipReason: string | null;
  dominantSkipCount: number;
  hosts: HookHost[];
  /** Ran enough to be meaningful, and wrote nothing. */
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
  let lastWriteAt: string | null = null;
  let lastEntity: string | null = null;
  let lastSkipReason: string | null = null;
  const skipCounts = new Map<string, number>();
  const hosts = new Set<HookHost>();
  for (const r of records) {
    hosts.add(r.host);
    if (lastRunAt === null || r.at >= lastRunAt) lastRunAt = r.at;
    if (r.outcome === 'wrote') {
      writes++;
      if (lastWriteAt === null || r.at >= lastWriteAt) {
        lastWriteAt = r.at;
        lastEntity = r.entity ?? null;
      }
    } else if (r.outcome === 'skipped') {
      skips++;
      lastSkipReason = r.reason ?? null;
      const key = r.reason ?? 'unspecified';
      skipCounts.set(key, (skipCounts.get(key) ?? 0) + 1);
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
    writes,
    skips,
    errors,
    lastRunAt,
    lastWriteAt,
    lastEntity,
    lastSkipReason,
    dominantSkipReason,
    dominantSkipCount,
    hosts: [...hosts].sort(),
    silent: runs >= SILENT_HOOK_MIN_RUNS && writes === 0,
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
      (h) => (HEARTBEAT_HOOKS as readonly string[]).includes(h) && !withRecords.has(h),
    ).sort()
    : [];

  // A silent hook is reported by the one with the most runs: it is the one
  // with the most evidence behind the claim, not merely the first alphabetically.
  const silent = input.hooks.filter((h) => h.silent).sort((a, b) => b.runs - a.runs);
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
    const since = (hook.lastRunAt ?? '').slice(0, 10) || 'install';
    return `memesh: ${hook.hook} ran ${hook.runs} times since ${since} and wrote nothing — \`memesh doctor\` for the reason`;
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
