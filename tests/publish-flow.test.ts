/**
 * #359 round 4: behaviour tests for the WHOLE post-publish flow — poll,
 * `latest` read, decide, print, exit code — not just the pure decision
 * `decidePublishOutcome` already covers in isolation
 * (`tests/npm-latest-guard.test.ts`). Every dependency is a fake: no
 * network, no real npm publish, no real clock, no real sleep.
 *
 * This file exists because the pure-decision tests could not catch the
 * round-4 finding: a reviewer mutated `finish-release.mjs`'s CALL SITE to
 * hard-code `seen: pkgVersion` (or `prerelease: false`) and every one of 117
 * tests stayed green, because nothing exercised the WIRING between the poll
 * and the decision — only the decision function, fed inputs by hand. These
 * tests drive `runPostPublishFlow` itself, so a fake `readVersion` that is
 * never actually called, or a poll that reads the wrong tag, fails here.
 *
 * Round 6 (independent review): `tick` (optional) is gone; `write` (required)
 * is the ONLY raw, no-newline sink — it carries the header, every dot, and
 * the one trailing newline, matching HEAD's three bare
 * `process.stdout.write` call sites. `now` is gone entirely: `waitedMinutes`
 * reverted to HEAD's static formula (`pollAttempts * pollIntervalMs /
 * 60_000`), which needs no clock, so there is nothing left for a fake clock
 * to drive. The 8-row table below now asserts the FULL ordered `[{stream,
 * text}, ...]` transcript per row (not a substring check), and a new
 * describe block proves the crash-containment behaviour added for item 8:
 * a throwing `sleep`/`write`/`log` is reported as one truthful error line
 * with `exitCode: 1`, and a throwing `error` is allowed to escape rather
 * than being silently swallowed a second time.
 *
 * Round 7 (independent review): `runPostPublishFlow` is now `async` and
 * EVERY call site below `await`s it — including the "error itself throws"
 * test, which used to assert a SYNCHRONOUS throw
 * (`expect(() => fn()).toThrow(...)`) and now asserts a REJECTED promise
 * (`await expect(fn()).rejects.toThrow(...)`), because an async function
 * never throws synchronously; it always returns a rejected Promise instead.
 * A new describe block covers the crash-message bounding (whitespace/
 * newline collapse, length cap, non-`Error` throws) and the rejected-`sleep`
 * containment this round added.
 */
import { describe, it, expect, vi } from 'vitest';
import { runPostPublishFlow } from '../scripts/lib/publish-flow.mjs';

const V = '4.10.2';

/** Collects every raw `write` call and every tagged `log`/`error` call. */
function collector() {
  const lines: Array<{ sink: 'log' | 'error'; text: string }> = [];
  const writes: string[] = [];
  return {
    log: (text: string) => lines.push({ sink: 'log', text }),
    error: (text: string) => lines.push({ sink: 'error', text }),
    write: (text: string) => writes.push(text),
    lines,
    writes,
  };
}

/**
 * A `readVersion` fake. `atTag[tag]` is either a literal string/null
 * answer (returned every time), or a function of the call NUMBER for that
 * tag (1-based) so a test can make the poll take several attempts before
 * confirming.
 */
function fakeReadVersion(atTag: Record<string, string | null | ((callNo: number) => string | null)>) {
  const callsByTag: Record<string, number> = {};
  const callLog: string[] = [];
  const readVersion = (tag: string): string | null => {
    callLog.push(tag);
    callsByTag[tag] = (callsByTag[tag] ?? 0) + 1;
    const answer = atTag[tag];
    if (answer === undefined) throw new Error(`fakeReadVersion: unexpected tag "${tag}"`);
    return typeof answer === 'function' ? answer(callsByTag[tag]) : answer;
  };
  return { readVersion, callLog, callsByTag };
}

function baseDeps(overrides: Partial<{
  readVersion: (tag: string) => string | null;
  sleep: (ms: number) => void | Promise<void>;
  write: (text: string) => void;
  log: (text: string) => void;
  error: (text: string) => void;
}> = {}) {
  const out = collector();
  return {
    readVersion: overrides.readVersion ?? (() => null),
    sleep: overrides.sleep ?? vi.fn(),
    write: overrides.write ?? out.write,
    log: overrides.log ?? out.log,
    error: overrides.error ?? out.error,
    __out: out,
  };
}

describe('runPostPublishFlow — the 8-row truth table, THROUGH the flow (fakes, no network)', () => {
  // pollAttempts=3, pollIntervalMs=100_000 => waitedMinutes = round(3 *
  // 100_000 / 60_000) = 5, matching HEAD's real-constants value used
  // throughout tests/npm-latest-guard.test.ts — `sleep` is faked, so the
  // large interval costs nothing in wall-clock test time.
  const rows: Array<{
    name: string;
    prerelease: boolean;
    distTag: string;
    seenAtTag: string | null;
    latestAnswer: string | null;
    exitCode: number;
    lines: Array<{ text: string; stream: 'log' | 'error' }>;
  }> = [
    {
      name: 'stable, confirmed',
      prerelease: false, distTag: 'latest', seenAtTag: V, latestAnswer: null, exitCode: 0,
      lines: [{ stream: 'log', text: '  npm latest serves 4.10.2; consumer and post-release checks remain required.' }],
    },
    {
      name: 'stable, unconfirmed',
      prerelease: false, distTag: 'latest', seenAtTag: '4.10.1', latestAnswer: null, exitCode: 1,
      lines: [
        { stream: 'error', text: '  UNCONFIRMED: after ~5 minutes npm latest still serves 4.10.1, not 4.10.2.' },
        { stream: 'error', text: '  The tag and the GitHub Release exist. Check the publish run above,' },
        { stream: 'error', text: '  then re-check with: npm view @pcircle/memesh@latest version --prefer-online' },
      ],
    },
    {
      name: 'prerelease, confirmed, latest same',
      prerelease: true, distTag: 'next', seenAtTag: V, latestAnswer: '4.9.4', exitCode: 0,
      lines: [
        { stream: 'log', text: '  npm next serves 4.10.2; consumer and post-release checks remain required.' },
        { stream: 'log', text: '  npm latest remains 4.9.4.' },
      ],
    },
    {
      name: 'prerelease, confirmed, latest changed',
      prerelease: true, distTag: 'next', seenAtTag: V, latestAnswer: '4.10.0', exitCode: 1,
      lines: [
        { stream: 'log', text: '  npm next serves 4.10.2; consumer and post-release checks remain required.' },
        { stream: 'error', text: '  WRONG DIST-TAG: npm latest changed from 4.9.4 to 4.10.0. Reconcile the dist-tags before continuing.' },
      ],
    },
    {
      name: 'prerelease, confirmed, latest unreadable',
      prerelease: true, distTag: 'next', seenAtTag: V, latestAnswer: null, exitCode: 1,
      lines: [
        { stream: 'log', text: '  npm next serves 4.10.2; consumer and post-release checks remain required.' },
        {
          stream: 'error',
          text: '  UNKNOWN: could not read npm latest after the publish attempt (was 4.9.4). An unreadable answer is not evidence latest held still — reconcile the dist-tags by hand before trusting either channel.',
        },
      ],
    },
    {
      name: 'prerelease, unconfirmed, latest same',
      prerelease: true, distTag: 'next', seenAtTag: '4.10.1', latestAnswer: '4.9.4', exitCode: 1,
      lines: [
        { stream: 'error', text: '  UNCONFIRMED: after ~5 minutes npm next still serves 4.10.1, not 4.10.2.' },
        { stream: 'error', text: '  The tag and the GitHub Release exist. Check the publish run above,' },
        { stream: 'error', text: '  then re-check with: npm view @pcircle/memesh@next version --prefer-online' },
        { stream: 'log', text: '  npm latest remains 4.9.4.' },
      ],
    },
    {
      name: 'prerelease, unconfirmed, latest changed',
      prerelease: true, distTag: 'next', seenAtTag: '4.10.1', latestAnswer: '4.10.0', exitCode: 1,
      lines: [
        { stream: 'error', text: '  UNCONFIRMED: after ~5 minutes npm next still serves 4.10.1, not 4.10.2.' },
        { stream: 'error', text: '  The tag and the GitHub Release exist. Check the publish run above,' },
        { stream: 'error', text: '  then re-check with: npm view @pcircle/memesh@next version --prefer-online' },
        { stream: 'error', text: '  WRONG DIST-TAG: npm latest changed from 4.9.4 to 4.10.0. Reconcile the dist-tags before continuing.' },
      ],
    },
    {
      name: 'prerelease, unconfirmed, latest unreadable',
      prerelease: true, distTag: 'next', seenAtTag: '4.10.1', latestAnswer: null, exitCode: 1,
      lines: [
        { stream: 'error', text: '  UNCONFIRMED: after ~5 minutes npm next still serves 4.10.1, not 4.10.2.' },
        { stream: 'error', text: '  The tag and the GitHub Release exist. Check the publish run above,' },
        { stream: 'error', text: '  then re-check with: npm view @pcircle/memesh@next version --prefer-online' },
        {
          stream: 'error',
          text: '  UNKNOWN: could not read npm latest after the publish attempt (was 4.9.4). An unreadable answer is not evidence latest held still — reconcile the dist-tags by hand before trusting either channel.',
        },
      ],
    },
  ];

  it.each(rows.map((r) => [r.name, r]))('%s', async (_name, row) => {
    const { readVersion, callLog } = fakeReadVersion({
      [row.distTag]: row.seenAtTag,
      ...(row.prerelease ? { latest: row.latestAnswer } : {}),
    });
    const deps = baseDeps({ readVersion });
    const result = await runPostPublishFlow({
      prerelease: row.prerelease, distTag: row.distTag, pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 3, pollIntervalMs: 100_000,
    });
    expect(result.exitCode, row.name).toBe(row.exitCode);
    expect(result.lines, `transcript for ${row.name}`).toEqual(row.lines);
    // The lines the flow RETURNS must be exactly the lines it PRINTED,
    // dispatched to the sink each one's own tag names.
    expect(deps.__out.lines, `printed sinks for ${row.name}`).toEqual(
      row.lines.map((l) => ({ sink: l.stream, text: l.text })),
    );
    // The poll must have genuinely called readVersion for THIS row's own
    // distTag — not a fixed/faked value nobody asked for.
    expect(callLog.filter((t) => t === row.distTag).length, `${row.name}: readVersion(distTag) was never called`).toBeGreaterThan(0);
  });

  it('every row is covered exactly once', () => {
    expect(rows).toHaveLength(8);
  });
});

describe('runPostPublishFlow — the wiring itself, not just the decision', () => {
  it('the poll calls readVersion for the CALLER-SUPPLIED distTag, not a hard-coded one', async () => {
    const { readVersion, callLog } = fakeReadVersion({ next: V });
    await runPostPublishFlow({
      prerelease: true, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps: baseDeps({ readVersion }), pollAttempts: 5, pollIntervalMs: 1,
    });
    expect(callLog.every((t) => t === 'next' || t === 'latest'), 'polled a tag other than next/latest').toBe(true);
    expect(callLog).toContain('next');
  });

  it('stops polling as soon as it sees the target version — does not burn every attempt', async () => {
    // Confirms on the 3rd call to readVersion('next'); with pollAttempts=10
    // a loop that ignored the match would call it 10 times.
    const { readVersion, callsByTag } = fakeReadVersion({
      next: (callNo) => (callNo >= 3 ? V : '4.10.1'),
    });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps: baseDeps({ readVersion }), pollAttempts: 10, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(0);
    expect(callsByTag.next, 'the poll kept calling readVersion after it already saw the target').toBe(3);
  });

  it('reads `latest` strictly AFTER the poll ends, never before', async () => {
    const order: string[] = [];
    const readVersion = (tag: string) => {
      order.push(tag);
      return tag === 'next' ? V : '4.9.4';
    };
    await runPostPublishFlow({
      prerelease: true, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps: baseDeps({ readVersion }), pollAttempts: 3, pollIntervalMs: 1,
    });
    const lastNextIndex = order.lastIndexOf('next');
    const firstLatestIndex = order.indexOf('latest');
    expect(firstLatestIndex, 'latest was never read').toBeGreaterThan(-1);
    expect(firstLatestIndex, 'latest was read before the poll for next finished').toBeGreaterThan(lastNextIndex);
  });

  it('a readVersion that THROWS is treated as unreadable — non-zero, never "remains"', async () => {
    const readVersion = (tag: string): string | null => {
      if (tag === 'next') return '4.10.1'; // never confirms, so the flow goes on to read latest
      throw new Error('registry unreachable');
    };
    const result = await runPostPublishFlow({
      prerelease: true, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps: baseDeps({ readVersion }), pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.lines.some((l) => l.text.includes('UNKNOWN'))).toBe(true);
    expect(result.lines.some((l) => /remains/.test(l.text))).toBe(false);
  });

  it('a readVersion that returns null throughout is unconfirmed and unreadable — never a false "remains"', async () => {
    const { readVersion } = fakeReadVersion({ next: null, latest: null });
    const result = await runPostPublishFlow({
      prerelease: true, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps: baseDeps({ readVersion }), pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.lines.some((l) => /remains/.test(l.text))).toBe(false);
  });

  it('sleeps between attempts but not after the last one', async () => {
    const { readVersion } = fakeReadVersion({ next: '4.10.1' }); // never confirms
    const deps = baseDeps({ readVersion });
    await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 4, pollIntervalMs: 1,
    });
    expect(deps.sleep).toHaveBeenCalledTimes(3);
  });
});

describe('runPostPublishFlow — round 6: exact raw-stream writes, and the no-clock static waitedMinutes', () => {
  it('writes: HEAD-exact header, one dot per non-confirming attempt, one trailing newline — in that order, nothing else', async () => {
    const { readVersion } = fakeReadVersion({ next: (callNo) => (callNo >= 2 ? V : '4.10.1') });
    const deps = baseDeps({ readVersion });
    await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 5, pollIntervalMs: 1,
    });
    expect(deps.__out.writes).toEqual([
      '\n  waiting for npm next to serve 4.10.2 ',
      '.',
      '\n',
    ]);
  });

  it('writes one dot per attempt when the poll never confirms, still exactly one trailing newline', async () => {
    const { readVersion } = fakeReadVersion({ next: '4.10.1' }); // never confirms
    const deps = baseDeps({ readVersion });
    await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 3, pollIntervalMs: 1,
    });
    expect(deps.__out.writes).toEqual([
      '\n  waiting for npm next to serve 4.10.2 ',
      '.', '.', '.',
      '\n',
    ]);
  });

  it("waitedMinutes is HEAD's static formula (pollAttempts * pollIntervalMs / 60_000) — no clock dependency exists any more", async () => {
    const { readVersion } = fakeReadVersion({ next: '4.10.1', latest: '4.9.4' }); // never confirms
    const deps = baseDeps({ readVersion });
    const result = await runPostPublishFlow({
      prerelease: true, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 20, pollIntervalMs: 15_000, // HEAD's real constants
    });
    expect(result.lines[0]).toEqual({
      stream: 'error',
      text: '  UNCONFIRMED: after ~5 minutes npm next still serves 4.10.1, not 4.10.2.',
    });
  });
});

describe('runPostPublishFlow — round 6 item 8: a throwing dependency is contained, not swallowed or crashed raw', () => {
  it('a throwing sleep is reported as one truthful error line — exitCode 1, never a silent success', async () => {
    const { readVersion } = fakeReadVersion({ next: '4.10.1' }); // never confirms, so sleep gets called
    const sleep = () => { throw new Error('sleep broke'); };
    const deps = baseDeps({ readVersion, sleep });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 4, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    const expected = [{ stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (sleep broke); verify npm dist-tags by hand.' }];
    expect(result.lines).toEqual(expected);
    expect(deps.__out.lines).toEqual(expected.map((l) => ({ sink: l.stream, text: l.text })));
  });

  it('a throwing write (the header/dot/trailing-newline sink) is contained the same way', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const write = () => { throw new Error('stdout broke'); };
    const deps = baseDeps({ readVersion, write });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (stdout broke); verify npm dist-tags by hand.' },
    ]);
  });

  it('a throwing log — printing a NORMAL confirmed-outcome line — is contained', async () => {
    const { readVersion } = fakeReadVersion({ next: V }); // confirms immediately -> the confirmed line goes to log
    const log = () => { throw new Error('log broke'); };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (log broke); verify npm dist-tags by hand.' },
    ]);
  });

  it('a throwing error — printing a NORMAL unconfirmed-outcome line — escapes rather than being swallowed a second time', async () => {
    const { readVersion } = fakeReadVersion({ next: '4.10.1' }); // never confirms -> the normal path calls error()
    const error = () => { throw new Error('error sink broke'); };
    const deps = baseDeps({ readVersion, error });
    // The flow's OWN normal-path error() call throws; the catch block's
    // attempt to report the crash calls error() again and that throws too —
    // this second throw must propagate OUT of runPostPublishFlow rather than
    // being caught and turned into a quiet exitCode:1 with no message at all.
    // `runPostPublishFlow` is `async` (round 7): a throw inside it becomes a
    // REJECTED promise, never a synchronous throw, so this asserts on the
    // rejection, not on the call itself throwing.
    await expect(runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    })).rejects.toThrow('error sink broke');
  });
});

describe('runPostPublishFlow — round 7: the crash line is bounded to one line, and a rejected sleep is contained', () => {
  it('collapses an embedded newline in the thrown message to a single space — the crash line is always exactly one line', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const log = () => { throw new Error('a\nb'); };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (a b); verify npm dist-tags by hand.' },
    ]);
    expect(result.lines[0].text.includes('\n')).toBe(false);
  });

  it('collapses tabs and multiple consecutive newlines to a single space each, not one space per character', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const log = () => { throw new Error('a\n\n\tb'); };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.lines[0].text).toBe('  UNCONFIRMED: post-publish check crashed (a b); verify npm dist-tags by hand.');
  });

  it('caps a very long message at 200 characters TOTAL, ellipsis included, never emitted in full', async () => {
    // Round 9 (independent review): the message portion is 200 characters
    // WIDE, ellipsis included — 199 real characters plus the one-character
    // "…" — not 200 characters plus a 201st ellipsis character. Asserted
    // exactly (the extracted message substring's own `.length`), not just
    // "contains 200 x's", which the round-8 version of this test did and
    // which is exactly the shape that let the off-by-one through unnoticed.
    const { readVersion } = fakeReadVersion({ next: V });
    const longMessage = 'x'.repeat(4096);
    const log = () => { throw new Error(longMessage); };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    const text = result.lines[0].text;
    expect(text).toBe(`  UNCONFIRMED: post-publish check crashed (${'x'.repeat(199)}…); verify npm dist-tags by hand.`);
    const message = text.match(/crashed \((.*)\); verify/)![1];
    expect(message.length, 'the message portion, ellipsis included, must be exactly 200 characters').toBe(200);
    expect(message).not.toContain('x'.repeat(200));
  });

  it.each([
    [199, 199], // under the budget: no truncation, no ellipsis
    [200, 200], // exactly at the budget: no truncation, no ellipsis
    [201, 200], // one over: truncated to 199 real chars + a 1-unit ellipsis
  ])('round 10: a %i-character ASCII message truncates to exactly %i UTF-16 units', async (inputLength, expectedLength) => {
    const { readVersion } = fakeReadVersion({ next: V });
    const inputMessage = 'x'.repeat(inputLength);
    const log = () => { throw new Error(inputMessage); };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    const message = result.lines[0].text.match(/crashed \((.*)\); verify/)![1];
    expect(message.length).toBe(expectedLength);
    expect(message.endsWith('…')).toBe(inputLength > 200);
  });

  it("round 10: a message whose 199th/200th UTF-16 units are a surrogate pair truncates by CODE POINT — never leaves a lone unpaired surrogate", async () => {
    // Codex's own probe shape: 198 ASCII chars (198 UTF-16 units), then one
    // astral character 😀 (a SURROGATE PAIR — units 198 and 199), then one
    // more ASCII char (unit 200) — 201 units total, so truncation fires, and
    // the old UTF-16-unit slice cut unit 199 (the LOW half of the pair),
    // leaving a lone HIGH surrogate immediately before the ellipsis.
    const { readVersion } = fakeReadVersion({ next: V });
    const inputMessage = `${'x'.repeat(198)}😀z`;
    expect(inputMessage.length, 'fixture: must be 201 UTF-16 units, so truncation fires').toBe(201);
    const log = () => { throw new Error(inputMessage); };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    const message = result.lines[0].text.match(/crashed \((.*)\); verify/)![1];
    // Verified by direct execution (round-10 report): including the emoji at
    // all would push the result to 201 units (198 x's + a 2-unit emoji + a
    // 1-unit ellipsis), still over budget — the code-point-aware loop
    // correctly backs off ONE MORE code point (dropping the emoji entirely,
    // never splitting it) rather than keeping half of it.
    expect(message).toBe(`${'x'.repeat(198)}…`);
    expect(message.length).toBe(199);
    expect(message).not.toContain('😀');
    expect(/[\uD800-\uDFFF]/.test(message), 'a lone unpaired surrogate half must never appear in the output').toBe(false);
  });

  it('round 10: 300 emoji (600 UTF-16 units) truncate to whole emoji only — no split, no lone surrogate', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const inputMessage = '😀'.repeat(300);
    expect(inputMessage.length, 'fixture: 300 astral characters are 600 UTF-16 units').toBe(600);
    const log = () => { throw new Error(inputMessage); };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    const message = result.lines[0].text.match(/crashed \((.*)\); verify/)![1];
    // Verified by direct execution (round-10 report): 99 whole emoji (198
    // units) plus the 1-unit ellipsis is 199 units — the closest a 2-unit
    // code point can land under 200 without ever emitting a fragment of one.
    expect(message).toBe(`${'😀'.repeat(99)}…`);
    expect(message.length).toBe(199);
    expect(/[\uD800-\uDFFF]/.test(message.replace(/😀/g, '')), 'no lone surrogate half outside the whole emoji').toBe(false);
  });

  it('round 11: 10,000 astral characters truncate to the exact same output as 300 did, and FAST — the old per-code-point rebuild was O(n^2)', async () => {
    // Round 11 (independent review): `truncateToUtf16Budget`'s round-10 fix
    // was correct but rebuilt the WHOLE candidate string
    // (`codePoints.slice(0, count).join('')`) on every one of up to `n`
    // iterations — O(n^2). Measured THROUGH THIS REAL FLOW (not the
    // isolated function) before and after the round-11 rewrite, on this
    // machine: the OLD loop took 468.9ms for this exact 10,000-astral-
    // character case (Codex's own independent timing: 448ms at 10,000,
    // 112ms at 5,000, 19.5ms at 2,000 — all reproduced separately). The NEW
    // single linear pass with an early `break` (it stops at the first code
    // point that doesn't fit, never scanning the rest) took 0.05-0.3ms
    // across five repeated runs of this same case. 100ms is the ceiling
    // below: about 4.7x under the OLD implementation's measured time (so a
    // regression back to O(n^2) reliably fails it) and roughly 300-2000x
    // over the NEW implementation's measured time (so ordinary CI jitter
    // cannot make this flaky).
    const { readVersion } = fakeReadVersion({ next: V });
    const inputMessage = '😀'.repeat(10_000);
    expect(inputMessage.length, 'fixture: 10,000 astral characters are 20,000 UTF-16 units').toBe(20_000);
    const log = () => { throw new Error(inputMessage); };
    const deps = baseDeps({ readVersion, log });
    const t0 = performance.now();
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    const elapsedMs = performance.now() - t0;
    const message = result.lines[0].text.match(/crashed \((.*)\); verify/)![1];
    // Same exact shape the 300-emoji case above asserts: 99 whole emoji
    // (198 units) plus the 1-unit ellipsis is 199 units, regardless of how
    // many MORE emoji the input has beyond that — the truncation point
    // does not depend on the input's total length once it exceeds the
    // budget.
    expect(message).toBe(`${'😀'.repeat(99)}…`);
    expect(message.length).toBe(199);
    expect(elapsedMs, `must finish well under the OLD O(n^2) implementation's measured ~469ms for this input; took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(100);
  });

  it('throw "x" (a string, not an Error) is stringified safely', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const log = () => { throw 'x'; };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (x); verify npm dist-tags by hand.' },
    ]);
  });

  it('throw null is stringified safely, never crashes the crash handler itself', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const log = () => { throw null; };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (null); verify npm dist-tags by hand.' },
    ]);
  });

  it('throw undefined is stringified safely', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const log = () => { throw undefined; };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (undefined); verify npm dist-tags by hand.' },
    ]);
  });

  it('a value whose own toString() throws falls back to a fixed string instead of crashing the crash handler', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const hostile = { toString() { throw new Error('toString exploded'); } };
    const log = () => { throw hostile; };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines[0].text).toContain('post-publish check crashed ([value could not be converted to a string])');
  });

  it('round 8: a real Error whose `message` GETTER throws is contained — the access itself must not escape', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const hostile = new Error('placeholder');
    Object.defineProperty(hostile, 'message', {
      get() { throw new Error('message getter exploded'); },
    });
    const log = () => { throw hostile; };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed ([value could not be converted to a string]); verify npm dist-tags by hand.' },
    ]);
  });

  it('round 8: a real Error whose `message` is a non-string value is stringified, not left to crash raw.replace', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const hostile = new Error('placeholder');
    Object.defineProperty(hostile, 'message', { value: { not: 'a string' } });
    const log = () => { throw hostile; };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    // `String({not: 'a string'})` is `"[object Object]"` — a real, if
    // unhelpful, string; the important thing is that this does not throw.
    expect(result.lines[0].text).toContain('post-publish check crashed ([object Object])');
  });

  it('round 8: a Proxy that throws on every trap, including instanceof\'s own getPrototypeOf, is contained', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const hostile = new Proxy({}, {
      get() { throw new Error('get trap exploded'); },
      getPrototypeOf() { throw new Error('getPrototypeOf trap exploded'); },
      has() { throw new Error('has trap exploded'); },
    });
    const log = () => { throw hostile; };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed ([value could not be converted to a string]); verify npm dist-tags by hand.' },
    ]);
  });

  it('round 8: a thrown Symbol is stringified via the documented String(symbol) special case, not left to crash', async () => {
    const { readVersion } = fakeReadVersion({ next: V });
    const log = () => { throw Symbol('crash-cause'); };
    const deps = baseDeps({ readVersion, log });
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 2, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (Symbol(crash-cause)); verify npm dist-tags by hand.' },
    ]);
  });

  it('a REJECTED sleep is contained by the same try/catch — reported as UNCONFIRMED, exitCode 1, no unhandled rejection', async () => {
    const { readVersion } = fakeReadVersion({ next: '4.10.1' }); // never confirms, so sleep gets called
    const sleep = () => Promise.reject(new Error('registry poll interrupted'));
    const deps = baseDeps({ readVersion, sleep });
    // If the rejection were NOT awaited/contained, this `await` itself would
    // reject (or an unhandled-rejection listener elsewhere in the suite
    // would fire) instead of resolving to a normal result object.
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 4, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      { stream: 'error', text: '  UNCONFIRMED: post-publish check crashed (registry poll interrupted); verify npm dist-tags by hand.' },
    ]);
  });

  it('a synchronous (non-Promise) sleep still works exactly as before — await on a non-Promise resolves immediately', async () => {
    const { readVersion } = fakeReadVersion({ next: '4.10.1' }); // never confirms
    const deps = baseDeps({ readVersion }); // baseDeps' default sleep is a synchronous vi.fn()
    const result = await runPostPublishFlow({
      prerelease: false, distTag: 'next', pkgVersion: V, stableBefore: '4.9.4',
      deps, pollAttempts: 4, pollIntervalMs: 1,
    });
    expect(result.exitCode).toBe(1); // never confirms -> unconfirmed, not a crash
    expect(result.lines[0].text).toContain('UNCONFIRMED: after');
    expect(deps.sleep).toHaveBeenCalledTimes(3);
  });
});
