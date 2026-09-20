// The WHOLE post-publish flow — poll the registry for the dist-tag version,
// read `latest` after the poll ends, decide the outcome, print it, and
// produce the exit code — extracted from `scripts/finish-release.mjs` into
// ONE function with every real I/O dependency INJECTED, so the FLOW itself
// (not only the pure decision in `npm-latest-guard.mjs`) is behaviour-tested
// with fakes: no network, no real npm publish, no real clock.
//
// WHY THIS EXISTS (round 4, independent review)
//
// Round 1 moved the `latest` read outside the confirmed branch. Round 2
// found the script still combined the poll result and the latest verdict
// with its own `if` — fixed by `decidePublishOutcome` owning the WHOLE exit
// decision. Round 3 added source-text pins for the two remaining wiring
// facts (which value `finish-release.mjs` passed as `stableAfter`, and that
// it printed the real `lines`). Round 4 found that was still not enough:
// the POLL LOOP ITSELF, and the wiring between "ask the registry" and
// "decide the outcome", still lived in the script — untestable prose
// wearing a script's shape, no matter how many lines of it a text pin
// covered. Two independent reviewers mutated the call site the same way
// twice — hard-code `seen: pkgVersion`, or hard-code `prerelease: false` —
// and every one of 117 release tests stayed green, because nothing
// exercised the WIRING between the poll and the decision, only the decision
// function in isolation.
//
// So the poll moves in here too. `finish-release.mjs`'s remaining body is:
// gather real inputs (`dryRun`/`prerelease`/`distTag`/`pkgVersion`/
// `stableVersionBefore`), call `runPostPublishFlow`, and
// `process.exit(result.exitCode)` when it is non-zero — nothing else
// decides, and there is no real I/O left in the script to fake around.
// `seen` no longer exists as a script-level variable a call site could
// hard-code at all: it is computed INSIDE this function, by actually
// calling the injected `readVersion`.
//
// ROUND 6 CHANGES (independent review, output-parity + crash containment)
//
// 1. Output parity with HEAD. Rounds 4-5 had `log` play double duty as both
//    the raw "waiting for..." header write (via `deps.log`, which the real
//    CLI wires to `console.log` — an AUTO-NEWLINE sink) and the per-attempt
//    progress mark (via an OPTIONAL `deps.tick`). That is two bugs at once
//    against HEAD, which used a single raw `process.stdout.write` for the
//    header, every dot, AND one unconditional trailing newline after the
//    loop: (a) routing the header through `console.log` would have put a
//    newline where HEAD had a bare trailing space, breaking "dots on the
//    same line"; (b) `tick` being optional meant a caller (or a test fake)
//    that omitted it silently lost every dot with no error — and HEAD's
//    trailing `\n` after the loop had no equivalent here at all, so an
//    outcome line could print immediately after the last dot with nothing
//    between them. `tick` is gone; `write` is now REQUIRED and is the ONLY
//    thing that touches the raw, no-newline stream — header, dots, and the
//    one trailing newline, matching HEAD's three `process.stdout.write`
//    call sites exactly. `decidePublishOutcome`'s lines now carry their own
//    `stream` tag (see npm-latest-guard.mjs) and this function dispatches
//    each one to `log` or `error` by that tag, not by the flow's overall
//    exit code — restoring HEAD's per-line sink choice (the confirmation
//    line is always stdout, even when a later `latest` mismatch makes the
//    overall run fail).
//
// 2. `waitedMinutes` reverts to HEAD's STATIC formula
//    (`pollAttempts * pollIntervalMs / 60_000`, computed from this
//    function's own parameters) instead of the real-elapsed-time value
//    rounds 4-5 computed from an injected `now()`. That real-clock version
//    was never something a reviewer asked for; a test asserting it could
//    only compute the same formula the code does and assert equality
//    against itself — an assertion tautology, not a spec. `now` is REMOVED
//    from `deps` entirely: nothing in this flow needs a clock any more.
//
// 3. Crash containment. `readVersion` throwing was already contained (via
//    `safeRead`, below — treated as "could not read", never as "confirmed"
//    or "unchanged"). Nothing else was: a throwing `sleep`, `write`, `log`
//    or `error` used to escape `runPostPublishFlow` uncaught, which would
//    crash `finish-release.mjs` with a raw stack trace instead of the
//    truthful one-line verdict every other failure path prints. The whole
//    body now runs inside a try/catch; ANY dependency throwing outside
//    `readVersion` is reported as
//    `UNCONFIRMED: post-publish check crashed (<message>); verify npm
//    dist-tags by hand.` on `error`, with `exitCode: 1` — never a silent
//    exit-0. If `error` ITSELF throws while reporting that, the throw is
//    allowed to propagate (crashing the process, a non-zero exit by a
//    different mechanism) rather than being swallowed by a second
//    try/catch: a crash is honest, a caught-and-discarded second failure
//    is not.
//
// ROUND 7 CHANGES (independent review: the crash line was not bounded, and
// an async-rejecting `sleep` escaped)
//
// 1. The caught value's message used to be interpolated into the crash line
//    VERBATIM. A thrown `Error("a\nb")` put an embedded newline into what
//    the changelog calls "one truthful line"; a multi-kilobyte message was
//    emitted in full. `normalizeCrashMessage` below collapses every
//    whitespace run (including newlines) to a single space, strips any
//    remaining control character, and caps the result at 200 characters
//    with a trailing ellipsis — so the printed line is always exactly one
//    line, and always bounded. A non-`Error` throw (`throw 'x'`, `throw
//    null`, `throw undefined`, or a value whose own `toString` throws) is
//    stringified defensively, never left to crash the crash-handler itself.
//
// 2. `runPostPublishFlow` is now `async`, and `sleep` is `await`ed. Every
//    OTHER injected dependency (`readVersion`, `write`, `log`, `error`) is
//    still called synchronously and is expected to behave synchronously —
//    `sleep` is the one exception, because the real CLI's sleep is a
//    blocking `Atomics.wait` today but a test fake, or a future real
//    implementation, may reasonably return a Promise. Before this round, the
//    call was a bare `sleep(pollIntervalMs);` with no `await`: a fake that
//    returned a REJECTED promise did not throw inside this function at all —
//    the function returned its (wrong) normal result immediately, and the
//    rejection surfaced later as a raw unhandled-rejection crash with no
//    connection to the post-publish check that caused it. `await`ing it
//    inside the SAME try block means that rejection is now caught by the
//    same crash-containment path as every synchronous throw, before this
//    function's own returned Promise ever resolves.

import { decidePublishOutcome } from './npm-latest-guard.mjs';

/**
 * Truncates `text` to at most `maxUtf16Units` UTF-16 code units — what this
 * file's own contract means by "200 characters": JS string `.length` counts
 * UTF-16 code units, and an astral character (most emoji, and everything
 * else outside the Basic Multilingual Plane) is a SURROGATE PAIR, two units
 * for one visible character. Round 10 (independent review): the previous
 * version, `collapsed.slice(0, MAX_LENGTH - 1)`, sliced by UTF-16 UNIT — if
 * unit 199 happened to be the HIGH half of a surrogate pair, the slice cut
 * the pair in half, leaving a lone unpaired surrogate immediately before the
 * ellipsis. An unpaired surrogate is not valid UTF-8/UTF-16 text on its
 * own; written to a terminal or a log file it becomes U+FFFD (the Unicode
 * replacement character), silently altering the reported exception text —
 * the opposite of what a diagnostic message exists to do. Truncating by
 * CODE POINT instead makes that specific corruption impossible.
 *
 * Round 10's fix did that correctly but O(n²): it rebuilt the WHOLE
 * candidate string (`codePoints.slice(0, count).join('')`) on every one of
 * up to `n` iterations, re-scanning everything already kept just to drop
 * one more code point. Codex round 10 timed the real flow against an
 * astral-only exception message and got 19.5ms / 112ms / 448ms at 2,000 /
 * 5,000 / 10,000 code points (reproduced here: 20.0ms / 117.6ms / 455.0ms —
 * matches, and the input is never pre-sliced upstream). Round 11: ONE
 * linear pass over `text`'s code points (`for...of` iterates by code
 * point, same as `Array.from` did, but without materializing an array),
 * accumulating each code point's UTF-16 width until adding the next one
 * would exceed the budget (reserving 1 unit for the ellipsis) — then
 * BREAKS, so a huge excess input is never scanned past the ~199th code
 * point that actually survives. `text.slice(0, end)` then cuts at that
 * exact UTF-16-unit boundary, which is always a whole-code-point boundary
 * because `end` only ever advanced by a whole code point's width — the
 * same guarantee the array approach gave, without its cost: measured at
 * 2,000 / 5,000 / 10,000 / 1,000,000 astral code points, 0.043ms / 0.012ms
 * / 0.012ms / 0.724ms (effectively flat — the early `break` means the scan
 * length depends on the OUTPUT size, not the input size). Output verified
 * byte-for-byte identical to the round-10 version across every existing
 * test shape (ASCII at 199/200/201/4096, the surrogate-pair-at-boundary
 * case, 300 and 10,000 emoji, empty string) before this was made the real
 * implementation.
 */
function truncateToUtf16Budget(text, maxUtf16Units) {
  if (text.length <= maxUtf16Units) return text;
  const budget = maxUtf16Units - 1; // reserve 1 unit for the ellipsis
  let used = 0;
  let end = 0;
  for (const ch of text) {
    if (used + ch.length > budget) break; // first code point that doesn't fit — stop, don't scan the rest
    used += ch.length;
    end += ch.length;
  }
  return `${text.slice(0, end)}…`;
}

/**
 * Normalizes a caught value into a single bounded line of text, safe to
 * interpolate into the one-line crash diagnostic. Never itself throws.
 *
 * Round 8 (independent review): the round-7 version read `err.message`
 * OUTSIDE the defensive `try` — safe for an ordinary `Error`, but `message`
 * is an ordinary accessor property, and nothing stops a HOSTILE `Error` (a
 * `get message()` that throws, or a Proxy) or a non-`Error` throw whose
 * `.message`-shaped access still resolves to a non-string from making that
 * line itself throw, which would escape this function — and, since this
 * function is called FROM `runPostPublishFlow`'s own catch block, escape
 * THAT too, as a brand new, unrelated exception replacing the one being
 * reported. A `message` that resolves but is not a `string` had the same
 * problem one line later: `raw.replace(...)` assumes a string unconditionally.
 * Both the ACCESS and the STRING COERCION now happen inside the SAME `try`,
 * so any failure at either step — a throwing getter, a throwing
 * `[Symbol.toPrimitive]`/`toString`, a Proxy that throws on every trap
 * (including the `getPrototypeOf` trap `instanceof` itself relies on) — is
 * caught by the ONE fallback, and everything AFTER the `try` can assume a
 * plain string unconditionally.
 *
 * @param {unknown} err
 * @returns {string} At most 200 UTF-16 code units (`.length`), ellipsis
 *   included when truncated — NOT 200 code points and not 200 grapheme
 *   clusters; an astral character costs 2 units, so a message full of them
 *   fits fewer of them in the same budget. No newlines, no control
 *   characters. Truncation is by CODE POINT (round 10), so a surrogate pair
 *   is never split.
 */
function normalizeCrashMessage(err) {
  const MAX_LENGTH = 200;
  let raw;
  try {
    // `err instanceof Error` is inside the try too: for a Proxy, `instanceof`
    // itself can invoke the `getPrototypeOf` trap, which a hostile Proxy can
    // make throw before `.message` is ever reached.
    raw = err instanceof Error ? err.message : err;
    // `String(symbol)` is a documented special case that does NOT throw
    // (only implicit coercion — template literals, `+` — throws for a
    // Symbol); this still goes through the same try/catch as every other
    // shape, so nothing here relies on knowing that in advance.
    if (typeof raw !== 'string') raw = String(raw);
  } catch {
    raw = '[value could not be converted to a string]';
  }
  // Collapse EVERY whitespace run (space, tab, newline, ...) to one space
  // first — this is what turns a multi-line message into one line — then
  // strip any remaining control character `\s` does not already match
  // (e.g. a raw ANSI escape byte), then trim the ends, then cap the length.
  // `raw` is guaranteed a string by this point — every path above either
  // returns one directly or falls through to the fixed fallback string.
  // The literal control-character range below IS the point of this line —
  // same reasoning `eslint.config.js` already gives for turning the rule off
  // in `tests/**`, applied here as a narrow inline exception instead of a
  // second file-pattern override, since this is the one production call site
  // that needs it.
  // eslint-disable-next-line no-control-regex -- intentionally matching control characters to strip them from an untrusted message
  const collapsed = raw.replace(/\s+/g, ' ').replace(/[\x00-\x1F\x7F]/g, '').trim();
  // Round 9: the OUTPUT must be at most `MAX_LENGTH` UTF-16 units total,
  // ellipsis included. Round 10: truncation is by CODE POINT
  // (`truncateToUtf16Budget`, above), not by UTF-16 unit, so a surrogate
  // pair straddling the cut is never split into an unpaired half.
  return truncateToUtf16Budget(collapsed, MAX_LENGTH);
}

/**
 * @param {object} input
 * @param {boolean} input.prerelease
 * @param {string} input.distTag       'next' for a prerelease, 'latest' for
 *   a stable release — which tag the poll reads. Taken from the caller,
 *   never re-derived here: a caller that passes the wrong one is a GLUE
 *   mutation ("pass the wrong flag"), visible at its own call site, not
 *   something this function can protect against internally.
 * @param {string} input.pkgVersion    The version this run is publishing.
 * @param {string} input.stableBefore  `latest`, already read by the CALLER
 *   before the publish attempt (`checkReleasePreconditions` already
 *   requires this). This function never reads `latest` before the poll —
 *   only once, after — see the comment on `stableAfter` below for the
 *   mutation that ordering closes.
 * @param {object} input.deps
 * @param {(tag: string) => (string|null)} input.deps.readVersion  Reads the
 *   version published at `@pcircle/memesh@<tag>`. A THROW is treated
 *   identically to a `null` answer — "could not read it" — never as
 *   "unchanged" or "confirmed": see `safeRead` below. This is the ONE
 *   dependency whose throw is contained by design, not by the round-6
 *   try/catch (it was already contained before round 6).
 * @param {(ms: number) => (void|Promise<void>)} input.deps.sleep  The ONE
 *   dependency this function `await`s (round 7) — every other dependency is
 *   called synchronously and must behave synchronously. A synchronous
 *   `sleep` (the real CLI's blocking `Atomics.wait`) works unchanged:
 *   `await`ing a non-Promise return value resolves immediately. A fake that
 *   returns a REJECTED Promise is caught by the SAME try/catch as a
 *   synchronous throw, before this function's own returned Promise settles —
 *   never as a later, disconnected unhandled rejection.
 * @param {(text: string) => void} input.deps.write  RAW write, no implied
 *   newline — the real CLI passes `(text) => process.stdout.write(text)`.
 *   Used for the "waiting for..." header (embeds its own leading `\n` and
 *   trailing space, matching HEAD byte-for-byte), each per-attempt `.`, and
 *   the single unconditional `\n` after the poll loop ends. Required: there
 *   is no optional/no-op path any more (round 5's `tick` could be omitted
 *   silently; `write` cannot). Synchronous.
 * @param {(text: string) => void} input.deps.log    Called for outcome lines
 *   tagged `stream: 'log'` (see `decidePublishOutcome`) — informational,
 *   never a problem. Synchronous.
 * @param {(text: string) => void} input.deps.error  Called for outcome lines
 *   tagged `stream: 'error'`, and for the round-6 crash-containment message.
 *   Synchronous.
 * @param {number} [input.pollAttempts]    Defaults to 20.
 * @param {number} [input.pollIntervalMs]  Defaults to 15000.
 * @returns {Promise<{exitCode: number, lines: Array<{text: string, stream: 'log'|'error'}>}>}
 */
export async function runPostPublishFlow({
  prerelease,
  distTag,
  pkgVersion,
  stableBefore,
  deps,
  pollAttempts = 20,
  pollIntervalMs = 15_000,
}) {
  const { readVersion, sleep, write, log, error } = deps;

  function safeRead(tag) {
    try {
      return readVersion(tag);
    } catch {
      return null;
    }
  }

  try {
    // Leading `\n`, trailing space, no suffix — HEAD's exact header text,
    // written raw so the dots below land on the same line.
    write(`\n  waiting for npm ${distTag} to serve ${pkgVersion} `);

    let seen = null;
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      // The poll ACTUALLY calls the injected reader for the dist-tag this
      // release used — not a value a caller could hand it pre-computed. This
      // line, existing at all, is what closes the round-4 finding: there is
      // no `seen` variable anywhere outside this loop for a call site to
      // hard-code.
      seen = safeRead(distTag);
      if (seen === pkgVersion) break;
      write('.');
      // Not after the LAST attempt — the loop is about to end and report, and
      // a quarter-minute of dead wait on the failure path is the one place a
      // release flow must not add. `await`ed (round 7) so a rejected fake
      // sleep is caught by this function's own try/catch, not left to
      // surface later as an unhandled rejection.
      if (attempt < pollAttempts - 1) await sleep(pollIntervalMs);
    }
    // Unconditional — HEAD wrote this whether the loop broke early
    // (confirmed) or ran out (unconfirmed), and always BEFORE any
    // outcome/error line.
    write('\n');

    // `latest` is read AFTER the poll loop ends, unconditionally (for a
    // prerelease) — never reused from `stableBefore`, and never read before
    // the loop above starts. That ordering is what round 1 fixed; a mutation
    // that made this line `= stableBefore` instead of a fresh `safeRead`
    // would compare `latest` with itself and silently always report
    // "unchanged" — reproduced and killed in the round-4 report.
    const stableAfter = prerelease ? safeRead('latest') : null;

    // HEAD's static formula — see the round-6 header comment for why this
    // replaced a real-elapsed-time computation. Computed unconditionally;
    // `decidePublishOutcome` only reads it on the not-confirmed path.
    const waitedMinutes = Math.round((pollAttempts * pollIntervalMs) / 60_000);

    const outcome = decidePublishOutcome({
      prerelease, distTag, pkgVersion, seen, waitedMinutes, stableBefore, stableAfter,
    });
    // Per-LINE dispatch by the line's own tag, never by the flow's overall
    // exit code — see the round-6 header comment and npm-latest-guard.mjs.
    for (const line of outcome.lines) {
      (line.stream === 'log' ? log : error)(line.text);
    }
    return outcome;
  } catch (err) {
    // Anything other than `readVersion` throwing (already contained above)
    // lands here: a throwing/rejecting `sleep`, or a throwing `write`,
    // `log`, or `error` call made WHILE printing a NORMAL outcome line.
    // Report it truthfully instead of letting a raw stack trace — or an
    // unbounded, possibly multi-line message — stand in for a verdict.
    const message = normalizeCrashMessage(err);
    const text = `  UNCONFIRMED: post-publish check crashed (${message}); verify npm dist-tags by hand.`;
    // If `error` itself throws here, let it propagate — a crash is an
    // honest non-zero exit; catching this a second time to keep going would
    // be the swallowed failure the rest of this function exists to avoid.
    error(text);
    return { exitCode: 1, lines: [{ stream: 'error', text }] };
  }
}
