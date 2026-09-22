/**
 * The one "where we are" per project, and the four ways it could quietly lie.
 *
 * This state is injected at the top of every session, so a wrong value here is
 * more expensive than a missing one: an agent acts on a stale goal with full
 * confidence. Each test pins one property that keeps it honest — it belongs to
 * exactly one project, a resolved blocker can actually be removed, re-stating
 * something does not make it look fresher than it is, and unusable stored data
 * is dropped rather than shown.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  TASK_STATE_FIELDS,
  taskStateName,
  parseTaskState,
  normalizeFieldValue,
  mergeTaskState,
  isEmptyTaskState,
  taskStateLines,
  briefingTaskStateLines,
  STALE_TASK_STATE_HOURS,
  MAX_FIELD_CHARS,
  type TaskState,
} from '../../src/core/task-state.js';

const NOW = '2026-08-16T00:00:00.000Z';

describe('task-state', () => {
  it('keys the state by project, because entity names are globally unique', () => {
    // Without the project in the name, two repos share one row and every
    // session reads someone else's goal.
    expect(taskStateName('memesh')).not.toBe(taskStateName('other-repo'));
    expect(taskStateName('memesh')).toBe('task-state:memesh');
  });

  it('clears a field on an explicit empty string', () => {
    // The reason this exists: a blocker gets resolved. A state that can only
    // ever grow would keep injecting a blocker that is gone, and the agent
    // would keep working around it.
    const previous: TaskState = { goal: 'ship A1b', blocked: 'waiting on CI' };
    const { state, changed, observations } = mergeTaskState(previous, { blocked: '' }, NOW);

    expect(changed).toEqual(['blocked']);
    expect(state.blocked).toBeUndefined();
    expect(state.goal).toBe('ship A1b');
    expect(observations).toEqual(['blocked cleared']);
  });

  it('distinguishes "not mentioned" from "cleared"', () => {
    // undefined must leave a field alone — a caller setting only `next` must
    // not wipe the goal.
    const previous: TaskState = { goal: 'ship A1b', next: 'write tests' };
    const { state, changed } = mergeTaskState(previous, { next: 'open the PR' }, NOW);

    expect(changed).toEqual(['next']);
    expect(state.goal).toBe('ship A1b');
    expect(state.next).toBe('open the PR');
  });

  it('reports no change when a value is re-stated, and leaves the age alone', () => {
    // This is what bounds the storage: callers write only when something
    // changed, so the observation trail grows per CHANGE, not per session.
    // It is also what keeps the age honest — re-stating yesterday's goal today
    // must not make the thinking behind it look fresh.
    const previous: TaskState = { goal: 'ship A1b', updated_at: '2026-08-01T00:00:00.000Z' };
    const { state, changed, observations } = mergeTaskState(previous, { goal: 'ship A1b' }, NOW);

    expect(changed).toEqual([]);
    expect(observations).toEqual([]);
    expect(state.updated_at).toBe('2026-08-01T00:00:00.000Z');
  });

  it('normalises whitespace and bounds a single field', () => {
    expect(normalizeFieldValue('  ship   A1b\n  today ')).toBe('ship A1b today');
    expect(normalizeFieldValue('   ')).toBeNull();

    const long = 'x'.repeat(MAX_FIELD_CHARS + 50);
    const clipped = normalizeFieldValue(long)!;
    expect(clipped.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('drops stored values it cannot use instead of showing them', () => {
    // metadata is free-form JSON that older versions and other writers touch.
    // A half-parsed goal presented to an agent as fact is worse than no goal.
    expect(isEmptyTaskState(parseTaskState(null))).toBe(true);
    expect(isEmptyTaskState(parseTaskState('not an object'))).toBe(true);
    expect(isEmptyTaskState(parseTaskState({ task_state: 'nope' }))).toBe(true);

    const mixed = parseTaskState({ task_state: { goal: 'real goal', next: 42, blocked: '   ' } });
    expect(mixed.goal).toBe('real goal');
    expect(mixed.next).toBeUndefined();
    expect(mixed.blocked).toBeUndefined();
  });

  it('states how old it is, so a stale goal is not read as a fresh one', () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const heading = (updated: string) =>
      taskStateLines({ goal: 'g', updated_at: updated }, 'memesh', now)[0];

    expect(heading('2026-08-16T01:00:00.000Z')).toContain('today');
    expect(heading('2026-08-15T01:00:00.000Z')).toContain('yesterday');
    expect(heading('2026-07-16T12:00:00.000Z')).toContain('31 days ago');

    // An unusable stamp must not produce a wrong age — it produces none.
    expect(heading('not-a-date')).not.toMatch(/days ago|today|yesterday/);
  });

  it('renders the fields in the order a session needs to read them', () => {
    const lines = taskStateLines(
      { done: 'landed A1a', blocked: 'CI red on Windows', next: 'open the PR', goal: 'ship A1b' },
      'memesh',
      new Date('2026-08-16T12:00:00.000Z'),
    );
    const fields = lines.slice(1).map((l) => l.replace(/^- ([^:]+):.*$/, '$1'));
    expect(fields).toEqual(['Goal', 'Next', 'Blocked', 'Had just finished']);
    // Every declared field is renderable — a field added to the constant
    // without a label would silently never show up.
    expect(fields).toHaveLength(TASK_STATE_FIELDS.length);
  });

  it('says nothing at all when there is nothing to say', () => {
    // An empty heading promising state that is not there costs tokens and
    // reads as "memesh lost it".
    expect(taskStateLines({}, 'memesh')).toEqual([]);
    expect(taskStateLines({ updated_at: NOW }, 'memesh')).toEqual([]);
  });

  // #360 — briefingTaskStateLines is the ONE function the SessionStart hook
  // and the `briefing` tool/CLI both call for task state, so a stale record
  // reads the same everywhere. It must NOT change taskStateLines above:
  // `memesh task` renders directly through that function, and a human who
  // just ran it must see the real value, not "run `memesh task` to see it".
  describe('briefingTaskStateLines (#360)', () => {
    it('STALE_TASK_STATE_HOURS is 72 (three days)', () => {
      expect(STALE_TASK_STATE_HOURS).toBe(72);
    });

    it('an empty state is still nothing, regardless of includeFresh', () => {
      expect(briefingTaskStateLines({}, 'memesh')).toEqual([]);
      expect(briefingTaskStateLines({}, 'memesh', new Date(), { includeFresh: false })).toEqual([]);
    });

    it('a fresh state with includeFresh true renders exactly what taskStateLines renders', () => {
      const now = new Date('2026-08-16T12:00:00.000Z');
      const state: TaskState = { goal: 'ship it', updated_at: '2026-08-16T01:00:00.000Z' };
      expect(briefingTaskStateLines(state, 'memesh', now, { includeFresh: true }))
        .toEqual(taskStateLines(state, 'memesh', now));
    });

    it('a fresh state with includeFresh false is omitted entirely (the `minimal` level)', () => {
      const now = new Date('2026-08-16T12:00:00.000Z');
      const state: TaskState = { goal: 'ship it', updated_at: '2026-08-16T01:00:00.000Z' };
      expect(briefingTaskStateLines(state, 'memesh', now, { includeFresh: false })).toEqual([]);
    });

    it('a stale state renders ONE line naming the age and how to see it, regardless of includeFresh', () => {
      const now = new Date('2026-08-16T12:00:00.000Z');
      // 100 hours old — comfortably past the 72h threshold.
      const state: TaskState = { goal: 'ship it', updated_at: '2026-08-12T08:00:00.000Z' };
      for (const includeFresh of [true, false]) {
        const lines = briefingTaskStateLines(state, 'memesh', now, { includeFresh });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('"memesh"');
        expect(lines[0]).toContain('4 days ago');
        expect(lines[0]).toContain('72h');
        expect(lines[0]).toContain('memesh task');
        // Never the multi-line "Stated about" heading a fresh state gets.
        expect(lines[0]).not.toContain('Stated about');
      }
    });

    // Boundary, computed relative to a fixed `now` rather than a wall-clock
    // date — this repo shipped a release-blocking test that was red only
    // between 00:00-01:00 UTC (project_batches doc, #360's own acceptance
    // criteria calls this out by name).
    it('boundary: just under the threshold is still fresh, just over is stale', () => {
      const now = new Date('2026-08-16T12:00:00.000Z');
      const justUnder = new Date(now.getTime() - (STALE_TASK_STATE_HOURS - 0.01) * 3_600_000).toISOString();
      const justOver = new Date(now.getTime() - (STALE_TASK_STATE_HOURS + 0.01) * 3_600_000).toISOString();

      const fresh = briefingTaskStateLines({ goal: 'g', updated_at: justUnder }, 'memesh', now);
      expect(fresh.length).toBeGreaterThan(1);
      expect(fresh[0]).toContain('Stated about');

      const stale = briefingTaskStateLines({ goal: 'g', updated_at: justOver }, 'memesh', now);
      expect(stale).toHaveLength(1);
      expect(stale[0]).toContain('72h');
    });

    // Codex review round 1, item 3: this test used to assert the OPPOSITE —
    // that an unusable timestamp rendered as fresh ("at some point"). That
    // was the bug: "we don't know" is not "recent and trustworthy", and a
    // future-dated record used to be fresh FOREVER (an age that never
    // exceeds the threshold no matter how much wall-clock time passes).
    // Fail CLOSED instead — an unknown age gets its own one-line flag,
    // distinct from the ordinary stale line, at every level (`memesh task`
    // is the one place that still shows the raw value — see the file
    // header comment on why `taskStateLines` itself is untouched).
    describe('age cannot be established -> fail closed, one distinct line (item 3)', () => {
      const say = (state: TaskState, now = new Date('2026-08-16T12:00:00.000Z')) =>
        briefingTaskStateLines(state, 'memesh', now);

      it('missing updated_at', () => {
        const lines = say({ goal: 'g' });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('could not be established');
        expect(lines[0]).toContain('memesh task');
        expect(lines[0]).not.toContain('Stated about');
        expect(lines[0]).not.toContain('at some point');
      });

      it('malformed updated_at', () => {
        const lines = say({ goal: 'g', updated_at: 'not-a-date' });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('could not be established');
      });

      // Codex round 3, item 2: Date.parse accepts these and reads them in
      // the HOST's local timezone (date-only) or as local time (no offset)
      // — an age that depends on the reader's TZ is not portable, so both
      // are rejected before Date.parse ever runs (ZONED_INSTANT), not
      // inferred from whatever Date.parse decides.
      it('date-only updated_at ("2026-08-16") is ambiguous, not fresh', () => {
        const lines = say({ goal: 'g', updated_at: '2026-08-16' });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('could not be established');
      });

      it('a timezone-less datetime ("2026-08-13T12:30:00", no Z/offset) is ambiguous, not fresh', () => {
        const lines = say({ goal: 'g', updated_at: '2026-08-13T12:30:00' });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('could not be established');
      });

      it('the zone-less SQLite shape ("YYYY-MM-DD HH:MM:SS", no T, no Z) is ALSO ambiguous here', () => {
        // Unlike entities.created_at / observations.created_at (a real SQLite
        // CURRENT_TIMESTAMP column, UTC by SQLite's own definition — see
        // briefing-index.ts's parseActivity, which explicitly special-cases
        // THAT shape), task_state.updated_at lives inside the metadata JSON
        // blob and has exactly one writer (mergeTaskState via setTaskState),
        // which always stamps a full `Z`-suffixed ISO instant — verified
        // against a real row in the round-3 session report. This shape
        // reaching here can only be a hand edit or an imported bundle, and
        // is treated the same as any other unrecognised format.
        const lines = say({ goal: 'g', updated_at: '2026-08-13 12:30:00' });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('could not be established');
      });

      it('what the product itself writes IS accepted: a full Z-suffixed instant', () => {
        // The exact shape captured from a real row this code creates:
        // {"task_state":{"goal":"…","updated_at":"2026-09-19T20:35:34.805Z"}}
        const now = new Date('2026-09-19T21:00:00.000Z');
        const lines = say({ goal: 'g', updated_at: '2026-09-19T20:35:34.805Z' }, now);
        expect(lines[0]).toContain('Stated about');
        expect(lines[0]).not.toContain('could not be established');
      });

      // Codex round 3 re-review, item 1: ZONED_INSTANT validates SHAPE only
      // — Date.parse silently NORMALISES an impossible calendar value
      // (2026-02-30 becomes March 2) instead of rejecting it, so a typo'd
      // date used to read as a confidently-computed "stale" age. Every case
      // below is a value that MATCHES the shape regex but is not a real
      // instant, plus the boundary pairs that prove the day-of-month check
      // is leap-year-aware and not just "always reject Feb 29/30".
      describe('impossible calendar values are unknown-age, not silently normalised (item 1)', () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        const unknown = (updatedAt: string) => say({ goal: 'g', updated_at: updatedAt }, now);

        it('February 30th does not roll over to March', () => {
          const lines = unknown('2026-02-30T00:00:00Z');
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain('could not be established');
          expect(lines[0]).not.toContain('72h'); // must not silently compute a stale age either
        });

        it('February 29th in a non-leap year is rejected', () => {
          const lines = unknown('2026-02-29T00:00:00Z'); // 2026 is not a leap year
          expect(lines[0]).toContain('could not be established');
        });

        it('February 29th in a leap year is a REAL date — accepted', () => {
          // 2024 is a leap year, and in the PAST relative to the fixed
          // `now` (2026-08-16) — well past the stale threshold, but that is
          // a DIFFERENT thing from "unknown": it is a known, valid, old
          // date, so it renders the ordinary ONE-line STALE flag, not the
          // unknown-age line.
          const lines = unknown('2024-02-29T00:00:00Z');
          expect(lines[0]).not.toContain('could not be established');
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain('72h'); // stale, correctly computed
        });

        it('month 13 is rejected', () => {
          expect(unknown('2026-13-01T00:00:00Z')[0]).toContain('could not be established');
        });

        it('month 0 is rejected', () => {
          expect(unknown('2026-00-10T00:00:00Z')[0]).toContain('could not be established');
        });

        it('April 31st is rejected (April has 30 days)', () => {
          expect(unknown('2026-04-31T00:00:00Z')[0]).toContain('could not be established');
        });

        it('hour 25 is rejected', () => {
          expect(unknown('2026-08-01T25:00:00Z')[0]).toContain('could not be established');
        });

        it('hour 24 (ISO "end of day") is rejected, a deliberate choice — see the code comment', () => {
          expect(unknown('2026-08-01T24:00:00Z')[0]).toContain('could not be established');
        });

        it('minute 60 is rejected', () => {
          expect(unknown('2026-08-01T23:60:00Z')[0]).toContain('could not be established');
        });

        it('second 60 (a leap second) is rejected, a deliberate choice — see the code comment', () => {
          expect(unknown('2026-08-01T23:59:60Z')[0]).toContain('could not be established');
        });

        it('offset hour 24 is rejected ("+24:00" is not a real UTC offset)', () => {
          expect(unknown('2026-08-01T00:00:00+24:00')[0]).toContain('could not be established');
        });

        it('offset minute 60 is rejected ("+08:60" is not a real UTC offset)', () => {
          expect(unknown('2026-08-01T00:00:00+08:60')[0]).toContain('could not be established');
        });

        // #360 round 7 (Codex round 6 re-review, item 2): `-00:00` is NOT
        // the same claim as `Z` or `+00:00` — RFC 3339 §4.3 defines
        // negative-zero as "this is UTC time, but the writer's local
        // offset is UNKNOWN", the opposite of the trusted-offset guarantee
        // this validator exists to require. `Date.parse` cannot tell the
        // difference (both become the same epoch instant), so this has to
        // be rejected in `isRealInstant`, before `Date.parse` ever runs.
        it('offset -00:00 is rejected (RFC 3339 §4.3: "UTC, offset unknown" is not a trusted offset)', () => {
          const lines = unknown('2026-08-16T11:00:00-00:00'); // 1h before `now` if trusted
          expect(lines[0]).toContain('could not be established');
          expect(lines[0]).not.toContain('Stated about');
        });

        it('the identical instant with Z is fresh (contrast case for -00:00, same clock)', () => {
          const lines = say({ goal: 'g', updated_at: '2026-08-16T11:00:00Z' }, now);
          expect(lines[0]).toContain('Stated about');
          expect(lines[0]).not.toContain('could not be established');
        });

        it('the identical instant with +00:00 is fresh too (contrast case for -00:00, same clock)', () => {
          const lines = say({ goal: 'g', updated_at: '2026-08-16T11:00:00+00:00' }, now);
          expect(lines[0]).toContain('Stated about');
          expect(lines[0]).not.toContain('could not be established');
        });

        it('offset -00:30 (a REAL negative offset, not negative-zero) stays valid', () => {
          // 11:00 local at -00:30 is 11:30Z — still fresh under `now`
          // (2026-08-16T12:00:00Z), 30 minutes old.
          const lines = say({ goal: 'g', updated_at: '2026-08-16T11:00:00-00:30' }, now);
          expect(lines[0]).toContain('Stated about');
          expect(lines[0]).not.toContain('could not be established');
        });

        it('the real writer shape is still fresh after this fix (regression check)', () => {
          const recent = new Date(now.getTime() - 2 * 3_600_000).toISOString();
          const lines = unknown(recent);
          expect(lines[0]).toContain('Stated about');
          expect(lines[0]).not.toContain('could not be established');
        });
      });

      it('future beyond the clock-skew allowance is NOT fresh forever — also unknown', () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        const wayFuture = new Date(now.getTime() + 24 * 3_600_000).toISOString(); // +24h
        const lines = say({ goal: 'g', updated_at: wayFuture }, now);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('could not be established');
        expect(lines[0]).not.toContain('Stated about');
      });

      it('the unknown-age line and the stale line read differently, so hook-outcomes/context readers can tell them apart', () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        const unknown = say({ goal: 'g', updated_at: 'garbage' }, now)[0];
        const stale = say({ goal: 'g', updated_at: '2026-08-01T00:00:00.000Z' }, now)[0];
        expect(unknown).not.toBe(stale);
        expect(unknown).not.toContain('72h');
        expect(stale).toContain('72h');
      });
    });

    it('a future timestamp WITHIN the clock-skew allowance is still fresh, not unknown', () => {
      const now = new Date('2026-08-16T12:00:00.000Z');
      // 2 minutes in the future — inside the 5-minute allowance.
      const future = new Date(now.getTime() + 2 * 60_000).toISOString();
      const lines = briefingTaskStateLines({ goal: 'g', updated_at: future }, 'memesh', now);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).not.toContain('could not be established');
      // taskStateLines' OWN age-in-days (unchanged, see its header comment)
      // floors a same-instant/near-future delta to a negative day count and
      // falls back to "at some point" — a cosmetic quirk of the untouched
      // fresh-heading renderer, not a gating defect: this line still proves
      // the record was classified as FRESH (not stale, not unknown).
      expect(lines[0]).toMatch(/today|at some point/);
    });

    // Codex review round 1, item 3's exact fixed-clock table.
    describe('exact boundary table (fixed clock, no wall-clock dependence)', () => {
      const now = new Date('2026-08-16T12:00:00.000Z');
      const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

      it('exactly 72h -> fresh', () => {
        const lines = briefingTaskStateLines({ goal: 'g', updated_at: hoursAgo(72) }, 'memesh', now);
        expect(lines[0]).toContain('Stated about');
      });

      it('71h59m -> fresh', () => {
        const lines = briefingTaskStateLines({ goal: 'g', updated_at: hoursAgo(71 + 59 / 60) }, 'memesh', now);
        expect(lines[0]).toContain('Stated about');
      });

      it('72h01m -> stale (one line)', () => {
        const lines = briefingTaskStateLines({ goal: 'g', updated_at: hoursAgo(72 + 1 / 60) }, 'memesh', now);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('72h');
        expect(lines[0]).not.toContain('could not be established');
      });
    });

    // Codex round 3, item 2: reproduces the reviewer's exact scenario
    // (now=2026-08-16T12:00:00Z, updated_at="2026-08-13T12:30:00" — no
    // zone) and requires the SAME verdict under every timezone. Follows
    // this repo's established in-process TZ-mutation pattern
    // (tests/core/doctor.test.ts's "hook-activity: a SQLite timestamp is
    // read as UTC on any machine timezone"), including its self-guard: if
    // this runtime silently ignored process.env.TZ, the whole test would be
    // vacuously green, so the guard proves the runtime actually varies
    // local-time construction before trusting the "identical verdict" claim.
    describe('cross-timezone regression (item 2): the same ambiguous string never disagrees with itself', () => {
      const original = process.env.TZ;
      afterEach(() => {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      });

      const ZONES = ['UTC', 'Asia/Taipei', 'America/Los_Angeles'];

      it('guard: this runtime actually varies local-time construction under TZ (or the rest of this block proves nothing)', () => {
        process.env.TZ = 'UTC';
        const utcNoon = new Date(2026, 0, 1, 12, 0, 0).getTime();
        process.env.TZ = 'Asia/Taipei';
        const taipeiNoon = new Date(2026, 0, 1, 12, 0, 0).getTime();
        expect((utcNoon - taipeiNoon) / 3_600_000, 'this runtime ignores process.env.TZ').toBe(8);
      });

      it('a zone-less datetime — the reviewer\'s exact reproduction — is "unknown" under every TZ, never fresh in some and stale/fresh in others', () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        for (const tz of ZONES) {
          process.env.TZ = tz;
          const lines = briefingTaskStateLines({ goal: 'g', updated_at: '2026-08-13T12:30:00' }, 'memesh', now);
          expect(lines, `TZ=${tz}`).toHaveLength(1);
          expect(lines[0], `TZ=${tz}`).toContain('could not be established');
        }
      });

      it('a date-only string is "unknown" under every TZ', () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        for (const tz of ZONES) {
          process.env.TZ = tz;
          const lines = briefingTaskStateLines({ goal: 'g', updated_at: '2026-08-16' }, 'memesh', now);
          expect(lines, `TZ=${tz}`).toHaveLength(1);
          expect(lines[0], `TZ=${tz}`).toContain('could not be established');
        }
      });

      it('a real (Z-suffixed) instant reads identically fresh under every TZ', () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        const updatedAt = '2026-08-16T01:00:00.000Z'; // 11h ago — fresh
        const rendered: string[] = [];
        for (const tz of ZONES) {
          process.env.TZ = tz;
          const lines = briefingTaskStateLines({ goal: 'g', updated_at: updatedAt }, 'memesh', now);
          expect(lines[0], `TZ=${tz}`).toContain('Stated about');
          rendered.push(lines.join('\n'));
        }
        expect(rendered[0], 'the SAME zoned instant must render identically regardless of TZ').toBe(rendered[1]);
        expect(rendered[0]).toBe(rendered[2]);
      });

      it('a real (Z-suffixed) stale instant reads identically stale under every TZ', () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        const updatedAt = '2026-08-01T00:00:00.000Z'; // well past 72h
        for (const tz of ZONES) {
          process.env.TZ = tz;
          const lines = briefingTaskStateLines({ goal: 'g', updated_at: updatedAt }, 'memesh', now);
          expect(lines, `TZ=${tz}`).toHaveLength(1);
          expect(lines[0], `TZ=${tz}`).toContain('72h');
        }
      });
    });
  });
});

// The id a project is stored under is `<label>~<32 lowercase hex>`; the lines a
// person or a model READS name the project by its label. The hash stays in
// `taskStateName` (an entity name identifies data).
describe('task-state lines name the project by its label, never the routing hash', () => {
  const HASH = '2c0fe491888c8efb9a4894828bbc2733';
  const ID = `memesh~${HASH}`;
  const now = new Date('2026-08-16T12:00:00.000Z');

  it('the fresh block', () => {
    const lines = taskStateLines({ goal: 'ship it', updated_at: '2026-08-16T01:00:00.000Z' }, ID, now);
    expect(lines[0]).toBe('Stated about "memesh" today, and not revisited since:');
  });

  it('the one-line stale flag', () => {
    const lines = briefingTaskStateLines({ goal: 'g', updated_at: '2026-08-12T08:00:00.000Z' }, ID, now);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Task state for "memesh" was last stated 4 days ago/);
    expect(lines[0]).not.toContain(HASH);
  });

  it('the one-line unknown-age flag', () => {
    const lines = briefingTaskStateLines({ goal: 'g' }, ID, now);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Task state for "memesh" has a missing, unreadable, or future-dated timestamp/);
    expect(lines[0]).not.toContain(HASH);
  });

  it('but the entity NAME keeps the full id: it identifies the row', () => {
    expect(taskStateName(ID)).toBe(`task-state:${ID}`);
  });
});
