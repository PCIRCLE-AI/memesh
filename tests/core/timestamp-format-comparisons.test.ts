/**
 * Timestamp comparisons across two storage formats must use parsed instants.
 *
 * SQLite stores what it is given. `CURRENT_TIMESTAMP` writes
 * `'YYYY-MM-DD HH:MM:SS'`; JavaScript's `toISOString()` writes
 * `'YYYY-MM-DDTHH:MM:SS.sssZ'`. Both live in this database — `created_at` and
 * legacy telemetry rows came from SQLite, while `last_accessed_at` and every
 * cutoff computed in JS come from Date. Compared as TEXT they first differ at index
 * 10, and the separator decides the whole comparison:
 *
 *     ' '  is 0x20     'T'  is 0x54     so ' ' sorts BEFORE 'T'
 *
 * Same instant, opposite verdicts. The fix is one rule: normalise before
 * comparing — `datetime(?)` in SQL or `parseSqliteUtcMs` in JS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { parseSqliteUtcMs } from '../../src/core/time-utils.js';

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-tsfmt-'));
  saved = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  try { closeDatabase(); } catch { /* none open */ }
  openDatabase(path.join(dir, 'kg.db'));
});

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (saved === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** How far back the product's own cutoff sits, in ms. */
function cutoffMsFor(days: number): number {
  return Date.now() - days * DAY;
}

describe('the separator does decide a raw TEXT comparison', () => {
  it("' ' sorts before 'T', so the two formats disagree about the same instant", () => {
    // Not a test of memesh — a test of the premise every fix below rests on.
    // If this ever stops being true, the fixes are solving nothing.
    const now = new Date();
    const iso = now.toISOString();
    const sqlite = iso.replace('T', ' ').slice(0, 19);
    expect(sqlite < iso, 'the same moment no longer compares unequal across formats').toBe(true);
  });
});

describe('a plan touched on the cutoff day is not stale', () => {
  it('does not count a plan whose last access is one hour inside the window', async () => {
    // `stalePlanCount` compares `last_accessed_at` — written by trackAccess
    // as an ISO string — against `datetime('now','-30 days')`, which is
    // SQLite's format. 'T' sorts AFTER ' ', so an ISO stamp on the cutoff
    // day always read as NEWER than the cutoff, whatever the hour: a plan
    // untouched for 30 days and 20 hours still counted as fresh.
    const { computePmAnalytics } = await import('../../src/core/analytics.js');
    const db = getDatabase();
    db.prepare("INSERT INTO entities (name, type, status) VALUES ('a-plan', 'plan', 'active')").run();
    // Just OUTSIDE the window, on the same calendar day as the cutoff. The
    // day has to match or the defect cannot bite: the two formats first differ
    // at index 10, so the separator only decides the comparison when the date
    // halves are equal.
    //
    // This was `cutoff - HOUR`, and `cutoff` carries the CURRENT time of day —
    // so between 00:00 and 01:00 UTC one hour earlier is the PREVIOUS day and
    // the fixture guard failed. It fired in exactly one place: the npm publish
    // run for v4.7.0, which started at 00:06 UTC. Every local run and all 13
    // CI legs had passed, at other hours. A test whose verdict depends on the
    // wall clock is not a test — it is a coin the clock flips.
    //
    // Clamped to midnight of the cutoff's own UTC day, which is inside the
    // window at every hour. (The one instant it cannot express is a cutoff
    // landing exactly on 00:00:00.000 UTC, where "on the cutoff day AND older
    // than the cutoff" has no solution at all. One millisecond a day, stated
    // here rather than left to be rediscovered.)
    const cutoff = cutoffMsFor(30);
    const cutoffDate = new Date(cutoff);
    const dayStart = Date.UTC(
      cutoffDate.getUTCFullYear(), cutoffDate.getUTCMonth(), cutoffDate.getUTCDate(),
    );
    const justStale = new Date(Math.max(cutoff - HOUR, dayStart)).toISOString();
    expect(justStale.slice(0, 10), 'fixture: not on the cutoff day')
      .toBe(cutoffDate.toISOString().slice(0, 10));
    expect(Date.parse(justStale), 'fixture: not actually older than the cutoff')
      .toBeLessThan(cutoff);
    db.prepare("UPDATE entities SET last_accessed_at = ? WHERE name = 'a-plan'").run(justStale);

    expect(computePmAnalytics(db).staleness.stalePlanCount,
      'a plan past the cutoff was reported as fresh').toBe(1);
  });

  it('does not count a plan touched today — the anti-vacuity half', async () => {
    const { computePmAnalytics } = await import('../../src/core/analytics.js');
    const db = getDatabase();
    db.prepare("INSERT INTO entities (name, type, status) VALUES ('fresh-plan', 'plan', 'active')").run();
    db.prepare("UPDATE entities SET last_accessed_at = ? WHERE name = 'fresh-plan'")
      .run(new Date().toISOString());

    expect(computePmAnalytics(db).staleness.stalePlanCount,
      'a plan touched today was reported as stale').toBe(0);
  });
});

describe('recency ordering uses the instant, not the text', () => {
  it('ranks by parsed time where a TEXT compare would invert it', () => {
    // What `kg-backfill`'s Rule 2 does when it picks the newest anchor for a
    // project. `localeCompare` on `created_at` ordered by the string, and
    // the two stored formats differ at the separator — so a value written
    // one way always sorted after a value written the other way from the
    // same second, regardless of which was actually newer.
    const older = '2026-08-24 08:00:00';
    const newer = '2026-08-24 09:00:00';

    const byInstant = [older, newer].sort(
      (a, b) => (parseSqliteUtcMs(b) ?? -Infinity) - (parseSqliteUtcMs(a) ?? -Infinity),
    );
    expect(byInstant[0]).toBe(newer);
  });

  it('sorts a timestamp it cannot trust LAST, not first', () => {
    // The policy Rule 5 already set and Rule 2 did not follow: a value the
    // parser will not vouch for must not become a number that sorts.
    // `localeCompare` put a full ISO string ahead of every SQLite-format
    // sibling from the same day, because 'T' sorts after ' '.
    const trusted = '2026-08-24 09:00:00';
    const untrusted = '2026-08-24T10:00:00.000Z';   // newer in real time

    expect(parseSqliteUtcMs(untrusted), 'the parser no longer rejects a suffixed value').toBeNull();
    expect(untrusted.localeCompare(trusted), 'fixture: the formats no longer disagree as TEXT')
      .toBeGreaterThan(0);

    const byInstant = [trusted, untrusted].sort(
      (a, b) => (parseSqliteUtcMs(b) ?? -Infinity) - (parseSqliteUtcMs(a) ?? -Infinity),
    );
    expect(byInstant[0], 'an untrusted timestamp was ranked as the newest').toBe(trusted);
  });
});

describe('the demo tour writes the format the column holds', () => {
  it('back-dates a seeded entity in SQLite format, so the parser trusts it', async () => {
    // demo.ts was the one writer putting a full ISO string into
    // `created_at`. Every demo entity was therefore untrusted by
    // `parseSqliteUtcMs`, invisible to the relation backfill's anchoring,
    // and out of order against its CURRENT_TIMESTAMP siblings — in the one
    // dataset a new user's first impressions are built from.
    const { seedDemo } = await import('../../src/core/demo.js');
    const result = seedDemo(getDatabase());
    expect(result.inserted, 'fixture: the tour seeded nothing').toBeGreaterThan(0);

    const rows = getDatabase()
      .prepare("SELECT name, created_at FROM entities WHERE json_extract(metadata, '$.demo') = 1")
      .all() as Array<{ name: string; created_at: string }>;
    expect(rows.length, 'fixture: no demo rows carry the marker').toBeGreaterThan(0);

    const unparseable = rows.filter((r) => parseSqliteUtcMs(r.created_at) === null);
    expect(unparseable.map((r) => `${r.name}=${r.created_at}`),
      'a demo entity carries a timestamp the repo\'s own parser rejects').toEqual([]);
  });
});
