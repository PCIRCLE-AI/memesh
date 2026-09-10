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

export const HOOK_OUTCOMES_FILENAME = 'hook-outcomes.json';
export const HOOK_OUTCOMES_VERSION = 1;

/**
 * Records kept per hook. Bounded because this file is read on every
 * SessionStart: unbounded history would make the cheapest hook path grow
 * without limit, and nothing here needs more than a recent window.
 */
export const HOOK_OUTCOMES_PER_HOOK = 20;

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
 * Parse the on-disk file, fail-CLOSED to empty.
 *
 * A corrupt file must not throw into a hook (capture matters more than
 * diagnostics) and must not be half-trusted either: a partially readable
 * history would under-count runs and could turn a dead hook green.
 */
export function parseHookOutcomes(raw: string | null | undefined): HookOutcomeFile {
  if (!raw) return emptyOutcomeFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyOutcomeFile();
  }
  if (!parsed || typeof parsed !== 'object') return emptyOutcomeFile();
  const hooksRaw = (parsed as { hooks?: unknown }).hooks;
  if (!hooksRaw || typeof hooksRaw !== 'object') return emptyOutcomeFile();
  const hooks: Record<string, HookOutcomeRecord[]> = {};
  for (const [hook, entries] of Object.entries(hooksRaw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const kept: HookOutcomeRecord[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.at !== 'string') continue;
      if (rec.outcome !== 'wrote' && rec.outcome !== 'skipped' && rec.outcome !== 'error') continue;
      const record: HookOutcomeRecord = {
        hook,
        at: rec.at,
        host: rec.host === 'claude-code' || rec.host === 'codex' ? rec.host : 'unknown',
        outcome: rec.outcome,
      };
      if (typeof rec.reason === 'string') record.reason = rec.reason;
      if (typeof rec.entity === 'string') record.entity = rec.entity;
      if (typeof rec.session_id === 'string') record.session_id = rec.session_id;
      kept.push(record);
    }
    if (kept.length) hooks[hook] = kept;
  }
  return { version: HOOK_OUTCOMES_VERSION, hooks };
}

/**
 * Append one record, oldest-first, bounded. Pure: returns a new file object
 * so the writer can serialise it and the tests can pin the bound without
 * touching a disk.
 */
export function appendHookOutcome(
  file: HookOutcomeFile,
  record: HookOutcomeRecord,
  limit: number = HOOK_OUTCOMES_PER_HOOK,
): HookOutcomeFile {
  const hooks: Record<string, HookOutcomeRecord[]> = { ...file.hooks };
  const existing = hooks[record.hook] ?? [];
  const next = [...existing, record];
  hooks[record.hook] = next.length > limit ? next.slice(next.length - limit) : next;
  return { version: HOOK_OUTCOMES_VERSION, hooks };
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
