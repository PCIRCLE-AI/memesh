/**
 * How long, counted from the start of the hook's process, each hook that asks
 * whether a session is private lets itself work. The host kills a hook at its
 * `timeout` in hooks.json and .codex-plugin/plugin.json; these stay a second or
 * more under it. `decide` is when the private-session check (`decidePrivacy`)
 * must have answered; `notes` is when reading transcripts for note names, or
 * importing notes, must stop. Past `decide` the answer is `unchecked(timeout)`
 * (nothing is saved, and the next run decides again); past `notes` more notes
 * are held instead. `tests/hooks/private-switch.test.ts` checks each against the
 * timeouts the manifests declare. A hook that opens the database after its
 * budget can wait `HOOK_BUSY_TIMEOUT_MS` (2 s) more for its lock, and then
 * writes its outcome record: that wait fits inside the second as well.
 */
import { performance } from 'perf_hooks';

export const HOOK_BUDGET_MS = Object.freeze({
  /** session-summary.js (Stop): the host's limit is 10 s. */
  stop: Object.freeze({ decide: 3000, notes: 6000 }),
  /** session-end-notes.js (SessionEnd): the host's limit is 3 s. */
  sessionEnd: Object.freeze({ decide: 1000, notes: 1800 }),
  /** private-session-mark.js (PostToolUse): the host's limit is 5 s. It does not decide: the call is the evidence. */
  privateMark: Object.freeze({ notes: 3000 }),
  /** pre-compact.js (PreCompact): the host's limit is 10 s. `read` is when counting the transcript's tool calls stops; the database lock wait (2 s) comes after it. */
  preCompact: Object.freeze({ decide: 4000, read: 6000 }),
  /** decision-nudge.js and codex-plan-activity.js (PostToolUse): the host's limit is 5 s. */
  postToolUse: Object.freeze({ decide: 2500 }),
  /** user-prompt-intent.js (UserPromptSubmit): the host's limit is 3 s. It does not decide; `renew` is when a private session's marker must be renewed. */
  userPrompt: Object.freeze({ renew: 1500 }),
});

/**
 * An absolute deadline (ms since the epoch) for a budget counted from the start
 * of this process. Throws for a budget that is not a number: an absent budget
 * made the deadline NaN, and a NaN deadline never passes, so the read it was
 * meant to bound ran until the host killed the hook and left no record.
 */
export function deadlineFor(budgetMs, nowMs = Date.now(), uptimeMs = performance.now()) {
  if (!Number.isFinite(budgetMs)) throw new Error(`a hook budget must be a number of milliseconds, not ${budgetMs}`);
  return nowMs + Math.max(0, budgetMs - uptimeMs);
}
