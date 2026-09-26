/**
 * #359: `finish-release.mjs` only checked whether npm `latest` moved on the
 * branch where the registry poll CONFIRMED the new version at `next` —
 * exactly the branch a mis-tagged publish would not take. When the poll
 * timed out (registry lag, measured ~9 minutes on the 4.10.1 cut), the
 * script exited UNCONFIRMED without ever reading `latest`.
 *
 * Round 2 (independent review): moving the `latest` read outside the branch
 * was not enough — the script still combined the poll result and the
 * latest-guard verdict with its OWN `if`, and mutating that one condition
 * (`!confirmed || latestGuard.exitCode !== 0` → `!confirmed`) left every test
 * in this file passing, because none of them proved the COMBINATION was
 * behaviour-tested, only that the guard function was called.
 * `decidePublishOutcome` is the fix: it owns the whole exit decision, so
 * `finish-release.mjs` has no condition of its own left to mutate. Row 4 of
 * the 8-row truth table below ("prerelease, confirmed, latest changed") is
 * what pins that: it is exactly the state the round-2 reviewer's mutation
 * (dropping the latest guard's influence on `exitCode`) made pass silently,
 * and the row fails the moment that mutation is applied — reproduced for
 * real against the source in this round's report, not simulated here.
 *
 * Round 6 (independent review): the sink for every line used to be chosen
 * from the run's FINAL exit code, not from what the line itself says — a
 * regression from what the pre-extraction script (git HEAD of
 * `finish-release.mjs`, before this PR's rounds 1-6) actually printed. HEAD
 * chose the sink PER LINE (the confirmation line is always stdout, even when
 * a LATER `latest` problem makes the overall run fail). The truth table below
 * now asserts the FULL ORDERED transcript — `[{stream, text}, ...]` — for
 * every row, not a "contains this substring" check, because a substring
 * check cannot see which sink a line went to or what order the lines came
 * in. The two STABLE rows (1-2) are asserted BYTE-IDENTICAL to HEAD's
 * literal strings, read via `git show HEAD:scripts/finish-release.mjs`:
 * stable releases never had a round-2-style wording change, so nothing about
 * their output should have moved. The six PRERELEASE rows are NOT compared
 * to HEAD text: HEAD never checked `latest` at all on the unconfirmed-poll
 * path (that omission is the round-1 bug this PR fixes), and the
 * `WRONG DIST-TAG` wording for a confirmed-but-moved `latest` is a
 * deliberate round-2 improvement over HEAD's reused `UNCONFIRMED:` prefix
 * (finding F6) — reverting it would undo a fix, not restore a regression.
 */
import { describe, it, expect } from 'vitest';
import { checkLatestUnmoved, decidePublishOutcome } from '../scripts/lib/npm-latest-guard.mjs';

const V = '4.10.2';

describe('checkLatestUnmoved (the latest-only half)', () => {
  it('a stable (non-prerelease) release never reads latest: exit 0, no lines', () => {
    expect(checkLatestUnmoved({ prerelease: false, stableBefore: '4.9.4', stableAfter: '4.10.0' }))
      .toEqual({ exitCode: 0, lines: [] });
  });

  it('prerelease + latest unchanged: exit 0, one log line', () => {
    expect(checkLatestUnmoved({ prerelease: true, stableBefore: '4.9.4', stableAfter: '4.9.4' })).toEqual({
      exitCode: 0,
      lines: [{ stream: 'log', text: '  npm latest remains 4.9.4.' }],
    });
  });

  it('prerelease + latest changed: exit non-zero, one error line, WRONG DIST-TAG naming before/after', () => {
    expect(checkLatestUnmoved({ prerelease: true, stableBefore: '4.9.4', stableAfter: '4.10.0' })).toEqual({
      exitCode: 1,
      lines: [{
        stream: 'error',
        text: '  WRONG DIST-TAG: npm latest changed from 4.9.4 to 4.10.0. Stop and report to the owner; npm is only changed through the release workflow.',
      }],
    });
  });

  it.each([[null], ['']])('prerelease + latest unreadable (%j): exit non-zero, one error line, UNKNOWN, never "remains"', (stableAfter) => {
    const r = checkLatestUnmoved({ prerelease: true, stableBefore: '4.9.4', stableAfter });
    expect(r.exitCode).not.toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].stream).toBe('error');
    expect(r.lines[0].text).toContain('UNKNOWN');
    expect(r.lines[0].text).not.toMatch(/remains/);
  });
});

describe('decidePublishOutcome — the 8-row truth table, exact transcript (round-2 + round-6 review requirement)', () => {
  // stable x {confirmed, unconfirmed}, prerelease x {confirmed, unconfirmed} x
  // {latest same, changed, unreadable}. `waitedMinutes: 5` throughout matches
  // what HEAD's own static formula produces with its default constants
  // (Math.round(20 * 15_000 / 60_000) === 5) — see tests/publish-flow.test.ts
  // for the test proving `runPostPublishFlow` actually computes that value
  // itself rather than a caller having to know it.
  const rows: Array<{
    name: string;
    input: Parameters<typeof decidePublishOutcome>[0];
    exitCode: number;
    lines: Array<{ text: string; stream: 'log' | 'error' }>;
  }> = [
    {
      name: 'stable, confirmed — byte-identical to HEAD',
      input: { prerelease: false, distTag: 'latest', pkgVersion: V, seen: V, waitedMinutes: 5, stableBefore: '4.9.4', stableAfter: '4.10.0' },
      exitCode: 0,
      lines: [
        { stream: 'log', text: '  npm latest serves 4.10.2; consumer and post-release checks remain required.' },
      ],
    },
    {
      name: 'stable, unconfirmed — byte-identical to HEAD',
      input: { prerelease: false, distTag: 'latest', pkgVersion: V, seen: '4.10.1', waitedMinutes: 5, stableBefore: '4.9.4', stableAfter: '4.10.0' },
      exitCode: 1,
      lines: [
        { stream: 'error', text: '  UNCONFIRMED: after ~5 minutes npm latest still serves 4.10.1, not 4.10.2.' },
        { stream: 'error', text: '  The tag and the GitHub Release exist. Check the publish run above,' },
        { stream: 'error', text: '  then re-check with: npm view @pcircle/memesh@latest version --prefer-online' },
      ],
    },
    {
      name: 'prerelease, confirmed, latest same',
      input: { prerelease: true, distTag: 'next', pkgVersion: V, seen: V, waitedMinutes: 5, stableBefore: '4.9.4', stableAfter: '4.9.4' },
      exitCode: 0,
      lines: [
        { stream: 'log', text: '  npm next serves 4.10.2; consumer and post-release checks remain required.' },
        { stream: 'log', text: '  npm latest remains 4.9.4.' },
      ],
    },
    {
      name: 'prerelease, confirmed, latest changed',
      input: { prerelease: true, distTag: 'next', pkgVersion: V, seen: V, waitedMinutes: 5, stableBefore: '4.9.4', stableAfter: '4.10.0' },
      exitCode: 1,
      lines: [
        { stream: 'log', text: '  npm next serves 4.10.2; consumer and post-release checks remain required.' },
        { stream: 'error', text: '  WRONG DIST-TAG: npm latest changed from 4.9.4 to 4.10.0. Stop and report to the owner; npm is only changed through the release workflow.' },
      ],
    },
    {
      name: 'prerelease, confirmed, latest unreadable',
      input: { prerelease: true, distTag: 'next', pkgVersion: V, seen: V, waitedMinutes: 5, stableBefore: '4.9.4', stableAfter: null },
      exitCode: 1,
      lines: [
        { stream: 'log', text: '  npm next serves 4.10.2; consumer and post-release checks remain required.' },
        {
          stream: 'error',
          text: '  UNKNOWN: could not read npm latest after the publish attempt (was 4.9.4). An unreadable answer is not evidence latest held still — stop and report to the owner; npm is only changed through the release workflow.',
        },
      ],
    },
    {
      name: 'prerelease, unconfirmed, latest same',
      input: { prerelease: true, distTag: 'next', pkgVersion: V, seen: '4.10.1', waitedMinutes: 5, stableBefore: '4.9.4', stableAfter: '4.9.4' },
      exitCode: 1,
      lines: [
        { stream: 'error', text: '  UNCONFIRMED: after ~5 minutes npm next still serves 4.10.1, not 4.10.2.' },
        { stream: 'error', text: '  The tag and the GitHub Release exist. Check the publish run above,' },
        { stream: 'error', text: '  then re-check with: npm view @pcircle/memesh@next version --prefer-online' },
        { stream: 'log', text: '  npm latest remains 4.9.4.' },
      ],
    },
    {
      name: 'prerelease, unconfirmed, latest changed',
      input: { prerelease: true, distTag: 'next', pkgVersion: V, seen: '4.10.1', waitedMinutes: 5, stableBefore: '4.9.4', stableAfter: '4.10.0' },
      exitCode: 1,
      lines: [
        { stream: 'error', text: '  UNCONFIRMED: after ~5 minutes npm next still serves 4.10.1, not 4.10.2.' },
        { stream: 'error', text: '  The tag and the GitHub Release exist. Check the publish run above,' },
        { stream: 'error', text: '  then re-check with: npm view @pcircle/memesh@next version --prefer-online' },
        { stream: 'error', text: '  WRONG DIST-TAG: npm latest changed from 4.9.4 to 4.10.0. Stop and report to the owner; npm is only changed through the release workflow.' },
      ],
    },
    {
      name: 'prerelease, unconfirmed, latest unreadable',
      input: { prerelease: true, distTag: 'next', pkgVersion: V, seen: '4.10.1', waitedMinutes: 5, stableBefore: '4.9.4', stableAfter: null },
      exitCode: 1,
      lines: [
        { stream: 'error', text: '  UNCONFIRMED: after ~5 minutes npm next still serves 4.10.1, not 4.10.2.' },
        { stream: 'error', text: '  The tag and the GitHub Release exist. Check the publish run above,' },
        { stream: 'error', text: '  then re-check with: npm view @pcircle/memesh@next version --prefer-online' },
        {
          stream: 'error',
          text: '  UNKNOWN: could not read npm latest after the publish attempt (was 4.9.4). An unreadable answer is not evidence latest held still — stop and report to the owner; npm is only changed through the release workflow.',
        },
      ],
    },
  ];

  it.each(rows.map((r) => [r.name, r]))('%s', (_name, row) => {
    const r = decidePublishOutcome(row.input);
    expect(r.exitCode, `exitCode for ${row.name}`).toBe(row.exitCode);
    expect(r.lines, `transcript for ${row.name}`).toEqual(row.lines);
    // "Print the `next` status once" (round-2 review F5): never more than one
    // UNCONFIRMED-prefixed line, whatever the latest state also says.
    const unconfirmedCount = r.lines.filter((l) => l.text.includes('UNCONFIRMED')).length;
    expect(unconfirmedCount, `${row.name}: UNCONFIRMED printed more than once`).toBeLessThanOrEqual(1);
  });

  it('every row is covered exactly once (8 rows: 2 stable x confirmed, 6 prerelease x confirmed x latest-state)', () => {
    expect(rows).toHaveLength(8);
  });
});
