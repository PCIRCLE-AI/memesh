// =============================================================================
// task-state — the one "where we are" per project
// =============================================================================
//
// A runtime leaf with no imports, so scripts/generate-hook-core.mjs can copy it
// next to the hooks (they must not import dist/). Same constraint, and same
// reason, as work-topology.ts.
//
// WHY THIS IS NOT DERIVED FROM A TRANSCRIPT
// -----------------------------------------
// The handoff plan had the Stop hook write this. It cannot, honestly. A
// transcript mechanically yields "edited 6 files, hit 2 errors" — turning that
// into "the goal is X" or "next is Y" is a machine guessing intent, and this
// repository has audited that exact shape three times (see the fake-working
// audits). `done` is no better: a session that edited files is not a session
// that finished anything.
//
// So all four fields are EXPLICIT. Something that actually knows — the agent
// being told by a human, or the human at the CLI — states them. The hook's job
// is to read this back at session start, not to invent it.
//
// STORAGE
// -------
// Current state lives in `metadata.task_state`; the observation trail records
// each change in a human-readable line. Metadata-as-state is the convention
// this repo already settled on for new fields (cf. `signal_score`,
// `work_status`) and it buys two things here: the read is O(1) with no
// ordering ambiguity, and the injected block cannot be wrong because two
// observations disagreed about which is newer.
//
// Observation growth is bounded by CHANGES, not by sessions: `mergeTaskState`
// reports nothing changed when a caller re-states the same value, and callers
// skip the write. A project that genuinely changes direction a few hundred
// times has a few hundred lines here, which is the history a human wants
// anyway.

/** The entity type. Already listed in work-topology's WORK_LAYER_TYPES. */
export const TASK_STATE_TYPE = 'task-state';

/**
 * The four fields, in the order a session needs to read them: what we are
 * aiming at, what to do next, what stands in the way, what is already behind
 * us.
 */
export const TASK_STATE_FIELDS = ['goal', 'next', 'blocked', 'done'] as const;

export type TaskStateField = (typeof TASK_STATE_FIELDS)[number];

export type TaskState = Partial<Record<TaskStateField, string>> & {
  /** ISO timestamp of the last field CHANGE (not the last write attempt). */
  updated_at?: string;
};

/** Longest a single field may be. Past this it is a memory, not a state. */
export const MAX_FIELD_CHARS = 300;

/**
 * Entity names are globally UNIQUE in this schema, so the project has to be in
 * the name — otherwise two projects' states would collide into one row and
 * every session would read someone else's goal.
 */
export function taskStateName(project: string): string {
  return `${TASK_STATE_TYPE}:${project}`;
}

/**
 * Read the current state out of an entity's parsed metadata.
 *
 * Tolerant by necessity — metadata is free-form JSON that older versions and
 * other writers also touch. Anything that is not a usable string for a known
 * field is dropped rather than surfaced: a half-parsed goal shown to an agent
 * as fact is worse than no goal.
 */
export function parseTaskState(metadata: unknown): TaskState {
  const state: TaskState = {};
  if (!metadata || typeof metadata !== 'object') return state;
  const raw = (metadata as Record<string, unknown>).task_state;
  if (!raw || typeof raw !== 'object') return state;
  const bag = raw as Record<string, unknown>;
  for (const field of TASK_STATE_FIELDS) {
    const value = bag[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) state[field] = trimmed;
  }
  const updated = bag.updated_at;
  if (typeof updated === 'string' && updated.trim()) state.updated_at = updated.trim();
  return state;
}

/**
 * Normalise one incoming field value.
 *
 * An explicit empty string CLEARS the field and returns null — that is the
 * whole point of having it: a blocker that got resolved must be removable, and
 * a state that can only ever grow would keep injecting a blocker that is gone.
 * `undefined` means "not mentioned", which is different from "cleared".
 */
export function normalizeFieldValue(value: string): string | null {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > MAX_FIELD_CHARS ? `${flat.slice(0, MAX_FIELD_CHARS - 1).trimEnd()}…` : flat;
}

export interface TaskStateMerge {
  /** The state to persist. Identical object content to `previous` when nothing changed. */
  state: TaskState;
  /** Fields whose value actually differs from `previous`. */
  changed: TaskStateField[];
  /** One human-readable line per change, for the observation trail. */
  observations: string[];
}

/**
 * Apply a patch, reporting what genuinely changed.
 *
 * The `changed` list is what makes the storage bounded: a caller that writes
 * only when this is non-empty adds a row per real change, not per session. It
 * is also what keeps `updated_at` truthful — re-stating today's goal tomorrow
 * must not make the state look fresher than the thinking behind it.
 */
export function mergeTaskState(
  previous: TaskState,
  patch: Partial<Record<TaskStateField, string>>,
  now: string,
): TaskStateMerge {
  const state: TaskState = { ...previous };
  const changed: TaskStateField[] = [];
  const observations: string[] = [];

  for (const field of TASK_STATE_FIELDS) {
    const incoming = patch[field];
    if (incoming === undefined) continue;
    const normalized = normalizeFieldValue(incoming);
    const current = state[field];
    if (normalized === (current ?? null)) continue;
    changed.push(field);
    if (normalized === null) {
      delete state[field];
      observations.push(`${field} cleared`);
    } else {
      state[field] = normalized;
      observations.push(`${field}: ${normalized}`);
    }
  }

  if (changed.length > 0) state.updated_at = now;
  return { state, changed, observations };
}

/** True when there is nothing worth showing. */
export function isEmptyTaskState(state: TaskState): boolean {
  return TASK_STATE_FIELDS.every((field) => !state[field]);
}

// `done` was 'Just finished'. That phrase asserts recency the store cannot
// know: the value is whatever was last SAID, and nothing says it again when the
// work moves on. Injected on 2026-08-24 it read "Just finished: v4.6.0" while
// 38 PRs had merged since and npm was serving 4.7.3. The label now describes
// when the claim was made, not how recent the event is.
const FIELD_LABELS: Record<TaskStateField, string> = {
  goal: 'Goal',
  next: 'Next',
  blocked: 'Blocked',
  done: 'Had just finished',
};

/** Whole days between two instants, floored; null when the stamp is unusable. */
function ageInDays(updatedAt: string | undefined, now: Date): number | null {
  if (!updatedAt) return null;
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  return days >= 0 ? days : null;
}

/**
 * The block injected at session start.
 *
 * The age is part of the heading, not decoration. A goal written six weeks ago
 * is likely finished or abandoned — an agent that knows the age can weigh it;
 * one that does not will act on a stale goal with full confidence.
 *
 * The heading used to read `Where "<project>" was left off`, which is a claim
 * about the project. It is not one: every field here is something a person
 * SAID, recorded when they said it and never revisited, because nothing tells
 * the store when the work moves on. Carrying the age was not enough to stop it
 * being read as status — on 2026-08-24 this block opened a session with
 * "Just finished: v4.6.0" against 38 merged PRs and a published 4.7.3, and the
 * age was right there in the heading.
 *
 * So the heading now attributes rather than asserts. What the project is
 * actually doing comes from `repo-state.ts`, which derives it from git on
 * every call and therefore cannot go stale.
 */
export function taskStateLines(
  state: TaskState,
  project: string,
  now: Date = new Date(),
): string[] {
  if (isEmptyTaskState(state)) return [];
  const days = ageInDays(state.updated_at, now);
  const age = days === null ? 'at some point' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const lines = [`Stated about "${project}" ${age}, and not revisited since:`];
  for (const field of TASK_STATE_FIELDS) {
    const value = state[field];
    if (value) lines.push(`- ${FIELD_LABELS[field]}: ${value}`);
  }
  return lines;
}

// =============================================================================
// #360 — the briefing surfaces' stale-task-state rule
// =============================================================================
//
// A task state nobody has revisited in a long time reads as current when it
// is not — the exact failure that cost this block its "Where X was left off"
// heading (see the comment above `taskStateLines`): a stale claim shown with
// full confidence. The fix there was to attribute rather than assert; this
// goes one step further and stops showing the claim at all once it is old
// enough that an agent acting on it is more likely to be wrong than right.
//
// This does NOT change `taskStateLines` above. `memesh task` (the CLI's own
// "what does this say" command) renders directly through it, and a human who
// just typed `memesh task` must see the actual value — telling them to
// "run `memesh task`" to see what `memesh task` just printed would be
// circular. Staleness only applies to the two INJECTION surfaces (the
// SessionStart hook and the `briefing` tool/CLI), so it lives in a separate
// function those two call instead.
/**
 * A task state whose last change is older than this is not injected as
 * current. 72 hours (three days): long enough that a goal stated on a Friday
 * still reads on the following Monday, short enough that "not revisited
 * since" reliably means "may no longer be true" rather than "normal weekend
 * gap". Applies at every briefing level, `full` included (#360).
 */
export const STALE_TASK_STATE_HOURS = 72;

/**
 * Codex review round 1, item 3: a clock is never perfectly synchronised.
 * Without an allowance, a task state stated one second ago on a host whose
 * clock is a few seconds fast would read `updated_at` as being in the
 * future — and, before this constant existed, a future timestamp was
 * treated as fresh with NO upper bound, which is worse: it never goes
 * stale. Small and deliberate: enough to absorb ordinary clock drift
 * between the process that wrote the record and the one now reading it,
 * far too small to let a wrong-but-plausible future date pass as current.
 */
export const CLOCK_SKEW_ALLOWANCE_MINUTES = 5;

/**
 * Whether `updatedAt`'s age relative to `now` can be trusted, and if so,
 * how old it is (clamped to zero — a timestamp inside the skew allowance
 * reads as "just now", never as a small negative).
 *
 * Four ways an age is UNKNOWN, all fail CLOSED (never treated as fresh):
 * missing, unparseable, AMBIGUOUS (see below), or in the future by more than
 * the skew allowance. A timestamp the store cannot make sense of — or cannot
 * pin to one instant — is exactly the kind of uncertainty this whole rule
 * exists to keep out of an agent's context — "we don't know" must never
 * render as "recent and trustworthy".
 *
 * AMBIGUOUS: `Date.parse` happily accepts a date-only string ("2026-08-16")
 * or a datetime with no zone ("2026-08-13T12:30:00") — and for the latter,
 * per the ECMA-262 spec Date.parse follows, treats it as LOCAL time on
 * whatever host runs the code. The same stored string then ages differently
 * depending on the reader's `TZ`: measured — `TZ=UTC` read a state stated
 * 71.5h earlier as fresh, `TZ=Asia/Taipei` (UTC+8) read the SAME string as
 * stale, `TZ=America/Los_Angeles` (UTC-7/8) read it fresh again. An age that
 * depends on the reader's timezone is not an age at all, so a string with no
 * explicit offset is rejected before `Date.parse` ever sees it — matched by
 * `ZONED_INSTANT` below, not inferred from whatever `Date.parse` decides.
 *
 * `updated_at`'s one writer, `mergeTaskState` (via `setTaskState`), stamps
 * `new Date().toISOString()` — always `…T…Z`, verified against a real row
 * this code creates (`writercheck` fixture in the round-3 session report).
 * `entities.created_at` / `observations.created_at` are a DIFFERENT column
 * (SQLite's zone-less `CURRENT_TIMESTAMP`, UTC by SQLite's own definition —
 * see `briefing-index.ts`'s `parseActivity`, which handles THAT shape
 * explicitly because THAT column's writer produces it); `task_state`'s
 * `updated_at` lives inside the `metadata` JSON blob and is never written by
 * SQLite's default, so accepting the zone-less SQLite shape here would be
 * accepting a format nothing writes into this specific field — the only way
 * a zone-less or date-only value reaches this function is a hand edit or an
 * imported bundle from elsewhere (`serializer.ts`'s import path carries
 * `metadata` through verbatim), which is exactly the untrustworthy input
 * this whole function exists to catch.
 */
// Named groups, so a caller validating the individual fields (below) does
// not have to track positional indices through an already-dense pattern.
const ZONED_INSTANT =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.\d+)?)?(?:(?<zulu>[Zz])|(?<offSign>[+-])(?<offHour>\d{2}):?(?<offMinute>\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

/**
 * `ZONED_INSTANT` validates only the SHAPE of a timestamp — it does not
 * stop `Date.parse` from silently NORMALISING an impossible calendar value
 * instead of rejecting it: `Date.parse('2026-02-30T00:00:00Z')` returns a
 * real epoch (March 2), because JS's Date arithmetic treats "day 30 of a
 * 28-day month" as "28 days past the 1st, keep counting" rather than as an
 * error. Round 3 of #360's review found this: a typo'd, impossible date
 * read as a confidently-computed "stale" age instead of "unknown".
 *
 * Every captured field is checked against its REAL range before the value
 * is trusted at all — this runs BEFORE `Date.parse`, which is why
 * `resolveTaskStateAge` below never sees a normalised value in the first
 * place. Two range decisions, made once and stated here (this repo's one
 * writer, `mergeTaskState`, never emits either shape, so neither costs a
 * real case, only closes a hole a hand-edit or import could reach):
 *
 *   - Hour `24` (ISO's "end of day", equivalent to `00:00:00` the next day)
 *     is rejected, not accepted-and-normalised — accepting it would make
 *     midnight representable two ways for no benefit here.
 *   - Second `60` (a leap second) is rejected the same way.
 */
function isRealInstant(groups: Record<string, string | undefined>): boolean {
  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = groups.second === undefined ? 0 : Number(groups.second);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  if (second > 59) return false;
  if (groups.zulu === undefined) {
    // An explicit numeric offset — same two-field range check, so
    // "+08:60" (no such offset) fails here rather than silently rolling
    // over into "+09:00" the way Date.parse's own arithmetic would.
    const offHour = Number(groups.offHour);
    const offMinute = Number(groups.offMinute);
    if (offHour > 23 || offMinute > 59) return false;
    // Round 7 (Codex round 6 re-review, item 2): `-00:00` (and the
    // colon-less `-0000`, admitted by the same regex group since the
    // colon is optional there) is NOT the same claim as `Z` or `+00:00`.
    // RFC 3339 §4.3 defines negative-zero as "UTC time, but the writer's
    // local offset is UNKNOWN" — the opposite of the trusted-offset
    // guarantee this fail-closed validator exists to require. `Date.parse`
    // does not distinguish it from `+00:00` (both become the same epoch
    // instant), so nothing downstream of `isRealInstant` would ever catch
    // this on its own; it has to be rejected HERE, before `Date.parse`
    // runs. This repo's one writer (`mergeTaskState`) always emits `Z`, so
    // this only matters for hand-edited or imported metadata — exactly the
    // case this validator was written for.
    if (groups.offSign === '-' && offHour === 0 && offMinute === 0) return false;
  }
  return true;
}

function resolveTaskStateAge(updatedAt: string | undefined, now: Date): { known: true; hours: number } | { known: false } {
  if (!updatedAt) return { known: false };
  const match = ZONED_INSTANT.exec(updatedAt);
  if (!match?.groups || !isRealInstant(match.groups)) return { known: false };
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return { known: false };
  const hours = (now.getTime() - then) / 3_600_000;
  if (hours < -(CLOCK_SKEW_ALLOWANCE_MINUTES / 60)) return { known: false };
  return { known: true, hours: Math.max(0, hours) };
}

/** The one-line stale flag: names the age, and the command that shows the
 *  full (possibly still-true) record — `memesh task`, the CLI command that
 *  renders `taskStateLines` directly, unaffected by this staleness rule. */
function staleTaskStateLine(project: string, hours: number): string {
  const days = Math.floor(hours / 24);
  const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'} ago`;
  return `Task state for "${project}" was last stated ${age} — older than ${STALE_TASK_STATE_HOURS}h, so it is not shown as current. Run \`memesh task\` to see or update it.`;
}

/** The one-line "we cannot tell how old this is" flag — deliberately
 *  different wording from `staleTaskStateLine` above: that one names a
 *  known age past the threshold, this one names the ABSENCE of a
 *  trustworthy age (missing, unparseable, or too far in the future). An
 *  agent reading hook-outcomes.jsonl or the block itself must be able to
 *  tell the two apart without opening the code. */
function taskStateAgeUnknownLine(project: string): string {
  return `Task state for "${project}" has a missing, unreadable, or future-dated timestamp, so its age could not be established — not shown as current. Run \`memesh task\` to see or update it.`;
}

/**
 * The task-state lines for an INJECTED briefing (SessionStart hook, the
 * `briefing` tool/CLI) — the ONE function both call, so they cannot disagree
 * about the stale rule or about what a level does to a fresh state.
 *
 *   - no state recorded            -> []
 *   - age unknown (missing/         -> ONE line (regardless of `includeFresh`
 *     unparseable/future beyond        — same reasoning as the stale case:
 *     the skew allowance)              an agent still benefits from being
 *                                       told a record exists but could not
 *                                       be trusted, over believing there was
 *                                       never one stated at all)
 *   - state older than the         -> ONE line (regardless of `includeFresh`
 *     threshold ("stale")             — see the module comment above)
 *   - state fresh, includeFresh    -> the full block (`taskStateLines`)
 *   - state fresh, !includeFresh   -> [] (the level does not show task state
 *                                       at all — e.g. `minimal`)
 *
 * `includeFresh` is the ONLY lever a briefing level has over task state
 * (`briefing-level.ts`'s `BriefingLevelPolicy.taskState`): neither flag line
 * is gated by it, for the same reason in both cases.
 */
export function briefingTaskStateLines(
  state: TaskState,
  project: string,
  now: Date = new Date(),
  { includeFresh = true }: { includeFresh?: boolean } = {},
): string[] {
  if (isEmptyTaskState(state)) return [];
  const age = resolveTaskStateAge(state.updated_at, now);
  if (!age.known) return [taskStateAgeUnknownLine(project)];
  if (age.hours > STALE_TASK_STATE_HOURS) {
    return [staleTaskStateLine(project, age.hours)];
  }
  return includeFresh ? taskStateLines(state, project, now) : [];
}
