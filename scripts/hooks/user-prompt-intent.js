#!/usr/bin/env node

// User Prompt Intent — UserPromptSubmit hook
//
// Runs on every prompt and does only deterministic work:
//   - tells the agent about messages waiting for this session's recipient;
//   - renews a private session's marker when its user is back;
//   - on a Node that cannot run MeMesh, records why and stays silent;
//   - records a prompt over MAX_PROMPT_CHARS as skipped;
//   - leaves a hook-outcome record on every exit path.
// It does not read the prompt's words. Saving is on by default, and whether
// the user asked not to save is the model's call, from the `remember` tool
// description. (The file keeps its old name: renaming
// it would move the install paths.)
//
// Defensive: never blocks user prompts, even on hook failure. Errors are
// surfaced to stderr (visible in Claude Code debug logs) rather than
// swallowed — stderr does not affect prompt submission.

import { pathToFileURL } from 'url';
import {
  hookErrorReason,
  SKIP_REASONS,
  recordHookOutcome,
  getMemeshDirFromDbPath,
  unreadMessageLines,
  SESSION_ID_MISMATCH_REASON,
} from './_shared.js';
import { hookNodeProblem, NODE_TOO_OLD_REASON } from './_shared.js';
import { join } from 'path';
import { existsSync, realpathSync } from 'fs';
import { sessionFileName } from './_generated/private-session.js';
import { deadlineFor, HOOK_BUDGET_MS } from './_hook-budgets.js';

/** Longest prompt (in characters) the hook accepts; a larger one is recorded as skipped. */
export const MAX_PROMPT_CHARS = 256 * 1024;

function logError(scope, msg) {
  // Hooks may write to stderr without blocking prompt submission. Use this
  // to surface failures in Claude Code debug logs instead of swallowing.
  try {
    process.stderr.write(`[memesh:${scope}] ${msg}\n`);
  } catch {
    // stderr itself failing is unrecoverable; stay silent.
  }
}

// Only run the stdin pipeline when invoked directly as a script — not when
// imported by the test suite for in-process unit testing. On Windows,
// `file://${process.argv[1]}` produces an invalid URL because the path uses
// backslashes; pathToFileURL() correctly normalizes to a file:// URL on
// every platform, so the comparison is portable.
//
// `import.meta.url` is the REAL path of this file; `process.argv[1]` is the
// path as the host typed it. Through a symlink (plugin cache, global npm
// prefix) the two differ, so compare the typed path first — under
// `--preserve-symlinks-main` Node leaves `import.meta.url` unresolved too, and
// resolving the typed side unconditionally would make them diverge — and only
// then the resolved path. A realpath failure on that fallback is left to
// throw: a crash is visible, "not the entry point" is not.
//
// Also reads "not main" for `node -` (`argv[1]` is the literal `-`;
// `realpathSync('-')` would throw) and `node -e`/`-p` (the eval flag is in
// `process.execArgv`; `argv[1]` is just the caller's first argument). That
// is `isMain()`'s (scripts/lib/verify-core.mjs) `-`/eval handling and its
// typed-path-then-realpath order, without its directory case: `node <dir>`
// reads as "not main" here, where `isMain()` throws. The hook cannot import
// `isMain()`: it ships standalone (package.json `files`).
const EVAL_FLAG = /^(-e|-p|-pe|--eval|--print)(=|$)/;
const entryPath = process.argv[1];
const isMainModule = Boolean(entryPath)
  && entryPath !== '-'
  && !process.execArgv.some((arg) => EVAL_FLAG.test(arg))
  && (import.meta.url === pathToFileURL(entryPath).href
    || import.meta.url === pathToFileURL(realpathSync(entryPath)).href);
if (isMainModule) {
  // See post-commit.js for why every exit path leaves a record (#327). This
  // hook's only effect is the additionalContext it injects, so its outcome is
  // `notified`, not `wrote`: doctor's `writes` answers "is memory capture
  // still alive", and a message reminder is not a memory.
  let payload = null;
  const record = (outcome, reason, entity) =>
    recordHookOutcome(process.env, { hook: 'user-prompt-intent', outcome, reason, entity, payload });

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      // Distinguish empty stdin (legitimate degenerate event) from malformed
      // input (protocol drift). Both stay non-blocking, but only malformed
      // input is logged — empty is normal, garbage indicates a real bug.
      let data = {};
      const trimmed = input.trim();
      if (trimmed) {
        try {
          data = JSON.parse(trimmed);
        } catch (parseErr) {
          logError('user-prompt-intent', `malformed stdin JSON (len=${input.length}): ${parseErr.message}`);
          record('error', 'malformed stdin JSON');
          return process.exit(0);
        }
      }

      payload = data;
      // On a Node that cannot run MeMesh the reminders below would send the agent to tools that always fail.
      if (hookNodeProblem('user-prompt-intent')) {
        record('error', NODE_TOO_OLD_REASON);
        return process.exit(0);
      }
      // A private session whose user is back: its marker is live again before the agent writes anything.
      // Only a session that has a marker pays for the import.
      try {
        if (typeof data.session_id === 'string' && data.session_id !== ''
          && existsSync(join(getMemeshDirFromDbPath(), 'private-sessions', sessionFileName(data.session_id)))) {
          const { renewPrivateNoteMarker } = await import('./_stop-notes.js');
          await renewPrivateNoteMarker({ sessionId: data.session_id, metaUrl: import.meta.url, deadlineAt: deadlineFor(HOOK_BUDGET_MS.userPrompt.renew), payload: data });
        }
      } catch (err) {
        record('error', hookErrorReason(err));
      }
      // Claude Code sends `prompt`; `user_prompt` is the older name. The text itself is never read.
      const prompt = data.prompt ?? data.user_prompt ?? '';
      const promptSkipped = typeof prompt === 'string' && prompt.length > MAX_PROMPT_CHARS;
      if (promptSkipped) record('skipped', SKIP_REASONS.promptTooLarge);
      // Messages waiting for the recipient this session declared in
      // MEMESH_RECIPIENT, or — under Claude Code with the channel configured,
      // or under Codex with no MEMESH_RECIPIENT at all — the owner-private
      // host fallback (resolveMessageRecipient).
      // Read-only and not memory capture, so it is not gated by autoCapture.
      // Empty when neither source names a recipient. An inbox that cannot be
      // read is recorded as an `error` of its own (a label, never the
      // message), next to whatever this prompt's outcome turns out to be, so
      // a skip below cannot be read as "nothing was waiting". A rejected
      // MEMESH_RECIPIENT is also recorded, as `notified`.
      const inboxLines = unreadMessageLines(
        process.env,
        (err) => record('error', `inbox: ${hookErrorReason(err)}`),
        (label) => record('notified', `recipient: MEMESH_RECIPIENT ignored (${label})`),
        { sessionId: data.session_id, cwd: data.cwd },
        () => record('notified', SESSION_ID_MISMATCH_REASON),
      );
      if (inboxLines.length === 0) {
        // An oversized prompt already has its own record.
        if (!promptSkipped) record('skipped', SKIP_REASONS.noMessageWaiting);
        return process.exit(0);
      }
      const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: inboxLines.join('\n') } };
      process.stdout.write(JSON.stringify(out));
      record('notified', undefined, 'hint:inbox');
      process.exit(0);
    } catch (err) {
      logError('user-prompt-intent', err?.message || err);
      record('error', hookErrorReason(err));
      process.exit(0);
    }
  });
}
