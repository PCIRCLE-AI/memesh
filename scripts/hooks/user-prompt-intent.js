#!/usr/bin/env node

// User Prompt Intent — UserPromptSubmit hook
//
// Detects when the user explicitly asks Claude to remember / save / memorize
// content from the current session, and injects a context hint reminding Claude
// to use the memesh `remember` tool for cross-project recall.
//
// Why a hint instead of autonomous capture? The user's intent is clear, but
// "what to remember" usually depends on the surrounding conversation —
// extracting that requires an LLM round and policy decisions (name, type,
// observations, namespace). A polite reminder keeps the calling agent in the
// loop with full conversation context, while still preventing the
// "I forgot to use memesh" failure mode that motivated this hook.
//
// Defensive: never blocks user prompts, even on hook failure. Errors are
// surfaced to stderr (visible in Claude Code debug logs) rather than
// swallowed — stderr does not affect prompt submission.
// Gated by `autoCapture` flag (same as other memesh write hooks).

import { pathToFileURL } from 'url';
import {
  isAutoCaptureEnabled,
  hookErrorReason,
  SKIP_REASONS,
  recordHookOutcome,
  unreadMessageLines,
  SESSION_ID_MISMATCH_REASON,
} from './_shared.js';
import { realpathSync } from 'fs';

// Patterns compiled at module load — invalid regex MUST fail loudly. Do
// NOT move into a try block "for safety": a regex compile error is a
// programmer error, not a runtime condition, and silencing it would hide
// real bugs.
//
// Design principle: when in doubt between matching and not matching, do
// NOT match — a missed hint is recoverable (user repeats themselves), but
// a false hint pollutes context and pressures the LLM into a wrong action.
//
// Disambiguation policy:
//   - All imperatives anchored to sentence start (^ or after .!?\n) to skip
//     interrogatives ("do you remember X?", "What does save to memesh do?").
//   - For save-class verbs, "memesh" suffix required to avoid false positives
//     on generic "save this" (could mean clipboard, file, bookmark, etc.).
//   - Supported languages: English, Spanish, French, Portuguese, Traditional Chinese.
//     Additional languages welcome via PR (provide native-speaker validation).
export const INTENT_PATTERNS = [
  // English: "Remember/memorize this|that"
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:remember|memorize)\s+(?:this|that)\b/im,
  // English: "save/add/store to memesh"
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:save|add|put|store|write)\s+(?:(?:this|that|it)\s+)?(?:to|in|into)\s+memesh\b/im,

  // Spanish: "Recordar/memorizar esto|eso"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:recordar|memorizar)\s+(?:esto|eso)\b/im,
  // Spanish: "guardar en memesh"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:guardar|añadir|almacenar)\s+(?:(?:esto|eso)\s+)?(?:en|a)\s+memesh\b/im,

  // French: "Rappeler/mémoriser ceci|cela"
  /(?:^|[.!?\n]\s*)(?:s'il vous plaît\s+)?(?:rappeler|mémoriser)\s+(?:ceci|cela|ça)\b/im,
  // French: "sauvegarder dans memesh"
  /(?:^|[.!?\n]\s*)(?:s'il vous plaît\s+)?(?:sauvegarder|enregistrer|ajouter)\s+(?:(?:ceci|cela|ça)\s+)?(?:dans|à)\s+memesh\b/im,

  // Portuguese: "Lembrar/memorizar isto|isso"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:lembrar|memorizar)\s+(?:isto|isso)\b/im,
  // Portuguese: "salvar em memesh"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:salvar|guardar|adicionar|armazenar)\s+(?:(?:isto|isso)\s+)?(?:em|no)\s+memesh\b/im,

  // Traditional Chinese: 記下來, 記到/存到/寫進/存進 memesh|記憶
  /記下來|記到\s*(?:memesh|記憶)|存到\s*(?:memesh|記憶)|寫進\s*(?:memesh|記憶)|存進\s*(?:memesh|記憶)/,
];

export function detectRememberIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  for (const re of INTENT_PATTERNS) {
    if (re.test(prompt)) return true;
  }
  return false;
}

// The returned string is consumed BY THE LLM as additionalContext, NOT by
// configuration or by Claude Code itself. Edits here change LLM behavior,
// not hook behavior.
export function buildHint() {
  return [
    '<memesh-remember-intent>',
    'The user asked you to save something. Store it with the memesh `remember` tool, keeping',
    'the facts a future session will need rather than session-local state. The simplest call',
    'is `note:` with the text (it accepts tags: too); for a structured memory pass name: (stable,',
    'descriptive), type: (such as decision, pattern, lesson_learned or preference), observations:',
    'and tags:. A decision also needs why: (the reason for it and what would make it stop holding);',
    'without it the call is refused.',
    'Scope: project work gets a project tag, project:<id>, where <id> is the `project` field of the',
    '`briefing` result (CLI: `memesh briefing --json`); a plain repository name is a different scope',
    'that this project\'s sessions never see. Machine-wide preferences use namespace=personal, memory',
    'shared with a team namespace=team, public best practice namespace=global. Leave namespace: out',
    'for a memory that already exists, because supplying it moves that memory.',
    'Then tell the user the entity name and id the tool returned.',
    '</memesh-remember-intent>',
  ].join('\n');
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
  // still alive", and an injected hint is not a memory. Both branches that
  // reach it — a remember intent and a waiting message — inject and
  // store nothing, so there is no writing branch here to keep.
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

      // Claude Code sends `prompt`. The `user_prompt` fallback is defensive:
      // Claude Code's transcript format changed once before (2026-05-07), so
      // we accept either name to survive a similar rename. If both are absent
      // or non-string, detectRememberIntent's type guard returns false safely.
      payload = data;
      const prompt = data.prompt ?? data.user_prompt ?? '';
      const rememberIntent = detectRememberIntent(prompt);
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
      if (!rememberIntent && inboxLines.length === 0) {
        record('skipped', SKIP_REASONS.noPromptIntent);
        return process.exit(0);
      }
      if (!isAutoCaptureEnabled(process.env) && inboxLines.length === 0) {
        record('skipped', SKIP_REASONS.autoCaptureOff);
        return process.exit(0);
      }

      const contexts = [];
      const hint = rememberIntent && isAutoCaptureEnabled(process.env);
      if (hint) contexts.push(buildHint());
      if (inboxLines.length > 0) contexts.push(inboxLines.join('\n'));
      const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: contexts.join('\n\n') } };
      process.stdout.write(JSON.stringify(out));
      record('notified', undefined, `hint:${hint ? 'remember-intent' : 'inbox'}`);
      process.exit(0);
    } catch (err) {
      logError('user-prompt-intent', err?.message || err);
      record('error', hookErrorReason(err));
      process.exit(0);
    }
  });
}
