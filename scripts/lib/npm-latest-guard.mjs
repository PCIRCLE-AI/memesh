// Does a prerelease publish (npm `next`) end in a state `finish-release.mjs`
// should let stand? — as a pure function, kept separate from the script for
// the same reason `release-preconditions.mjs` is: the happy path cannot be
// exercised locally without a real npm publish, so the only way to pin every
// branch is to hand the decision its inputs.
//
// THE BUG THIS CLOSES (round 1)
//
// The "did `latest` move" check used to live ONLY inside the branch where the
// poll confirmed `next` serves the new version — exactly the branch a
// mis-tagged publish will NOT take. When the registry lagged past the
// 5-minute poll (measured on the 4.10.1 cut: ~9 minutes), the script printed
// UNCONFIRMED and exited without ever reading `latest`.
//
// THE HOLE THAT FIX STILL LEFT (round 2, independent review)
//
// Moving the `latest` read outside the branch was not enough on its own: the
// script still combined the poll result and the latest-guard's verdict with
// its OWN `if (!confirmed || latestGuard.exitCode !== 0)`. A reviewer
// mutated that one condition to `if (!confirmed)` and every test still
// passed — the tests proved the guard function was CALLED, not that its
// answer controlled the outcome. `decidePublishOutcome` below is the fix:
// it owns the ENTIRE exit decision, including the combination, so
// `finish-release.mjs` has nothing left to recombine.
//
// THE OUTPUT-PARITY HOLE (round 6, independent review)
//
// Extracting the decision changed what got printed, not just how it was
// decided: the sink for every line used to be chosen from the FINAL exit
// code (all lines log, or all lines error) — but HEAD chose the sink PER
// LINE, and one specific case (a CONFIRMED poll whose `latest` then turns
// out wrong) printed the confirmation to stdout and the `latest` problem to
// stderr in the SAME run. `lines` below is therefore an array of `{text,
// stream}`, not bare strings: THE RULE, stated once, is that a line
// describing a problem carries `stream: 'error'` and a line describing state
// that is fine carries `stream: 'log'` — decided by what the line SAYS, never
// by the run's overall exit code. `runPostPublishFlow`
// (scripts/lib/publish-flow.mjs) dispatches on each line's own tag.

/**
 * Did npm `latest` move during a PRERELEASE publish? The narrower half of
 * the decision — deliberately ignorant of whether the poll for `next` itself
 * confirmed, so it cannot re-derive or re-print that separately (round-2
 * review finding: doing so produced two differently-worded "UNCONFIRMED:"
 * lines on the same failure, which flattened the severity of the one that
 * actually matters). `decidePublishOutcome` is what combines this with the
 * poll result.
 *
 * @param {object} input
 * @param {boolean} input.prerelease  A stable release has no `next`/`latest`
 *   split to reconcile and never reads `latest` a second time at all.
 * @param {string} input.stableBefore `latest`, read before the publish
 *   attempt. `finish-release.mjs` already refuses to proceed when this could
 *   not be read, so it is always a real version string by the time this runs.
 * @param {string|null} input.stableAfter `latest`, read again after the poll
 *   ends — on BOTH the confirmed and the UNCONFIRMED path. `null` means the
 *   read failed, which is UNKNOWN, never "unchanged": the registry not
 *   answering is not evidence that `latest` held still.
 * @returns {{exitCode: number, lines: Array<{text: string, stream: 'log'|'error'}>}}
 */
export function checkLatestUnmoved({ prerelease, stableBefore, stableAfter }) {
  // No behaviour change for a stable release: it has nothing to reconcile,
  // and never triggers a `latest` read at all.
  if (!prerelease) return { exitCode: 0, lines: [] };

  if (typeof stableAfter !== 'string' || stableAfter.length === 0) {
    // Absence is not evidence. A registry that would not answer is not proof
    // `latest` held still, so this must never fall through to "unchanged".
    return {
      exitCode: 1,
      lines: [{
        stream: 'error',
        text:
          `  UNKNOWN: could not read npm latest after the publish attempt (was ${stableBefore}). ` +
          'An unreadable answer is not evidence latest held still — reconcile the dist-tags by hand before trusting either channel.',
      }],
    };
  }
  if (stableAfter !== stableBefore) {
    // A distinct prefix from the poll-timeout "UNCONFIRMED:" lines
    // `decidePublishOutcome` may also emit — this is a DIFFERENT, more
    // severe finding (the wrong package may now be `latest`), and blending
    // it in with the confirmation-timeout wording buried it (round-2 review
    // finding F6).
    return {
      exitCode: 1,
      lines: [{
        stream: 'error',
        text: `  WRONG DIST-TAG: npm latest changed from ${stableBefore} to ${stableAfter}. Reconcile the dist-tags before continuing.`,
      }],
    };
  }
  return { exitCode: 0, lines: [{ stream: 'log', text: `  npm latest remains ${stableAfter}.` }] };
}

/**
 * The FULL decision for the post-publish registry check — the poll for
 * `next`/`latest` confirming, AND (for a prerelease) `latest` staying put.
 * `finish-release.mjs` calls this once and prints each returned line to ITS
 * OWN tagged sink; `exitCode` is the final word, not an input to a
 * recombination the script performs itself.
 *
 * @param {object} input
 * @param {boolean} input.prerelease
 * @param {string} input.distTag    `'next'` for a prerelease, `'latest'` for
 *   a stable release — the tag the poll was reading.
 * @param {string} input.pkgVersion The version this run is publishing.
 * @param {string|null} input.seen  What the registry poll last saw at
 *   `distTag`.
 * @param {number} input.waitedMinutes  How long the poll waited before
 *   giving up, for the UNCONFIRMED message — `Math.round(pollAttempts *
 *   pollIntervalMs / 60_000)`, the SAME static formula HEAD used (this
 *   function has no clock; the caller computes it from its own constants,
 *   matching HEAD byte-for-byte rather than reporting real elapsed time).
 * @param {string} input.stableBefore
 * @param {string|null} input.stableAfter
 * @returns {{exitCode: number, lines: Array<{text: string, stream: 'log'|'error'}>}}
 */
export function decidePublishOutcome({ prerelease, distTag, pkgVersion, seen, waitedMinutes, stableBefore, stableAfter }) {
  const confirmed = seen === pkgVersion;
  const lines = [];

  // The `next`/`latest` poll status — printed ONCE, here, and nowhere else.
  // Confirmation is always `log` (stdout), even when a later `latest`
  // problem makes the OVERALL run exit non-zero — HEAD printed this line to
  // stdout unconditionally, before it knew whether the `latest` check would
  // also pass, and round 6 restores that: the sink is a property of what
  // THIS line says, not of how the run ends.
  if (confirmed) {
    lines.push({ stream: 'log', text: `  npm ${distTag} serves ${pkgVersion}; consumer and post-release checks remain required.` });
  } else {
    lines.push(
      { stream: 'error', text: `  UNCONFIRMED: after ~${waitedMinutes} minutes npm ${distTag} still serves ${seen ?? 'an unreadable answer'}, not ${pkgVersion}.` },
      { stream: 'error', text: `  The tag and the GitHub Release exist. Check the publish run above,` },
      { stream: 'error', text: `  then re-check with: npm view @pcircle/memesh@${distTag} version --prefer-online` },
    );
  }

  const latestGuard = checkLatestUnmoved({ prerelease, stableBefore, stableAfter });
  lines.push(...latestGuard.lines);

  return { exitCode: confirmed && latestGuard.exitCode === 0 ? 0 : 1, lines };
}
