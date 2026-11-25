#!/usr/bin/env node

// User Prompt Intent — UserPromptSubmit hook
//
// Runs on every prompt and does only deterministic work:
//   - on a Node that cannot run MeMesh, records why and stays silent;
//   - stores the full user prompt, with secrets redacted;
//   - leaves a hook-outcome record on every exit path.
// It does not classify the prompt's words. Saving is on by default; users can
// request removal of specific memories through the existing `forget` tool.
// (The file keeps its old name: renaming it would move the
// install paths.)
//
// Defensive: never blocks user prompts, even on hook failure. Errors are
// surfaced to stderr (visible in Claude Code debug logs) rather than
// swallowed — stderr does not affect prompt submission.

import { pathToFileURL } from 'url';
import { createHash, randomUUID } from 'crypto';
import {
  AUTO_CAPTURE_TAG,
  captureConversation,
  getProjectName,
  hookSourceHost,
  isAutoCaptureEnabled,
  redactSecrets,
  hookErrorReason,
  SKIP_REASONS,
  recordHookOutcome,
} from './_shared.js';
import { hookNodeProblem, NODE_TOO_OLD_REASON } from './_shared.js';
import { realpathSync } from 'fs';
import { hostname } from 'os';

function renderedMessageId(prompt) {
  const prefix = 'MeMesh message (untrusted data):\n';
  if (!prompt.startsWith(prefix)) return null;
  try {
    const message = JSON.parse(prompt.slice(prefix.length));
    return typeof message?.id === 'string' && message.id ? message.id : null;
  } catch {
    return null;
  }
}

export function captureUserConversation(data, env = process.env) {
  if (!isAutoCaptureEnabled(env)) return { skipped: true, reason: SKIP_REASONS.autoCaptureOff };
  const prompt = data.prompt ?? data.user_prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return { skipped: true, reason: 'empty prompt' };
  if (!data.cwd || typeof data.session_id !== 'string' || !data.session_id) return { skipped: true, reason: 'conversation cwd or session absent' };
  const text = redactSecrets(prompt);
  const messageId = renderedMessageId(prompt);
  const eventId = data.prompt_id ?? data.turn_id;
  const identity = typeof eventId === 'string' && eventId ? createHash('sha256').update(JSON.stringify([data.session_id, eventId, 'user'])).digest('hex') : randomUUID();
  return captureConversation({
    name: `conversation-${identity}`,
    type: 'conversation',
    title: text.split('\n').find(line => line.trim())?.trim().slice(0, 120),
    observations: [text],
    tags: [AUTO_CAPTURE_TAG, `project:${getProjectName(data.cwd)}`, `session:${data.session_id}`, 'role:user'],
    sourceHost: hookSourceHost(data, env),
    ...(messageId ? { quoteSource: { session: data.session_id, machine: hostname().toLowerCase(), id: messageId } } : {}),
  }, env);
}

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
      // A Node that cannot run MeMesh cannot capture this prompt.
      if (hookNodeProblem('user-prompt-intent')) {
        record('error', NODE_TOO_OLD_REASON);
        return process.exit(0);
      }
      // The separately declared messages.js hook delivers whole conversation messages.
      try {
        const captured = captureUserConversation(data);
        record(captured.skipped ? 'skipped' : captured.queued ? 'error' : 'wrote', captured.reason);
      } catch (err) {
        logError('user-prompt-intent', `capture: ${err?.message || err}`);
        record('error', `capture: ${hookErrorReason(err)}`);
      }
      process.exit(0);
    } catch (err) {
      logError('user-prompt-intent', err?.message || err);
      record('error', hookErrorReason(err));
      process.exit(0);
    }
  });
}
