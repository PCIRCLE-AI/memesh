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
  getMemeshDirFromDbPath,
  unreadMessageLines,
  SESSION_ID_MISMATCH_REASON,
} from './_shared.js';
import { join } from 'path';
import { existsSync, realpathSync } from 'fs';
import { sessionFileName } from './_generated/private-session.js';
import { deadlineFor, HOOK_BUDGET_MS } from './_hook-budgets.js';

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
//     The blanks after the boundary exclude a newline (`[^\S\n]*`, not `\s*`):
//     a newline is itself a boundary, so the match set is the same, and the
//     scan stays linear. With `\s*` the time grew with the square of the line
//     breaks, which for a long prompt is far past the hook's 3 s budget.
//   - For save-class verbs, "memesh" suffix required to avoid false positives
//     on generic "save this" (could mean clipboard, file, bookmark, etc.).
//   - Supported languages: English, Spanish, French, Portuguese, Traditional Chinese.
//     Additional languages welcome via PR (provide native-speaker validation).
export const INTENT_PATTERNS = [
  // English: "Remember/memorize this|that"
  /(?:^|[.!?\n][^\S\n]*)(?:please\s+)?(?:remember|memorize)\s+(?:this|that)\b/im,
  // English: "save/add/store to memesh"
  /(?:^|[.!?\n][^\S\n]*)(?:please\s+)?(?:save|add|put|store|write)\s+(?:(?:this|that|it)\s+)?(?:to|in|into)\s+memesh\b/im,

  // Spanish: "Recordar/memorizar esto|eso"
  /(?:^|[.!?\n][^\S\n]*)(?:por favor\s+)?(?:recordar|memorizar)\s+(?:esto|eso)\b/im,
  // Spanish: "guardar en memesh"
  /(?:^|[.!?\n][^\S\n]*)(?:por favor\s+)?(?:guardar|añadir|almacenar)\s+(?:(?:esto|eso)\s+)?(?:en|a)\s+memesh\b/im,

  // French: "Rappeler/mémoriser ceci|cela"
  /(?:^|[.!?\n][^\S\n]*)(?:s'il vous plaît\s+)?(?:rappeler|mémoriser)\s+(?:ceci|cela|ça)\b/im,
  // French: "sauvegarder dans memesh"
  /(?:^|[.!?\n][^\S\n]*)(?:s'il vous plaît\s+)?(?:sauvegarder|enregistrer|ajouter)\s+(?:(?:ceci|cela|ça)\s+)?(?:dans|à)\s+memesh\b/im,

  // Portuguese: "Lembrar/memorizar isto|isso"
  /(?:^|[.!?\n][^\S\n]*)(?:por favor\s+)?(?:lembrar|memorizar)\s+(?:isto|isso)\b/im,
  // Portuguese: "salvar em memesh"
  /(?:^|[.!?\n][^\S\n]*)(?:por favor\s+)?(?:salvar|guardar|adicionar|armazenar)\s+(?:(?:isto|isso)\s+)?(?:em|no)\s+memesh\b/im,

  // Traditional Chinese: judged clause by clause in detectRememberIntent, not by a regex here
];

// Claude Code puts text the user did not type into the same prompt: messages
// from other sessions, system notices, task results, pasted blocks. That text
// must never count as a save request. A block is an opening tag that starts a
// line, a name from NON_USER_TAGS and a closing tag of the SAME name that ends
// a line; same-name blocks nest. Everything else is the user's own text and is
// kept: an unclosed tag (probably quoted), a tag mid-line, in `inline code` or
// in a ``` fence, a self-closing tag, a mismatched closing tag.
// Known limit: a closing tag that ends a line INSIDE a block's body cannot be
// told from the real one, so the rest of that message counts as the user's.
// Linear time: the tag pattern never scans past the next "<", the character
// walk visits each character once, and a closing tag finds its opener through
// `openByName` instead of searching the stack.
const NON_USER_TAGS = ['cross-session-message', 'system-reminder', 'task-notification', 'pasted_content'];
const NON_USER_TAG_RE = new RegExp(
  `<(\\/)?(${NON_USER_TAGS.join('|')})(?=[\\s/>])((?:"[^"<]*"|'[^'<]*'|[^<>"'])*)>`,
  'gi',
);
const LINE_END_AT = /[ \t\r]*(?:\n|$)/y;

export function stripNonUserBlocks(prompt) {
  const stack = []; // open tags: { name, start }, start = where the tag's line begins
  const openByName = new Map(NON_USER_TAGS.map((name) => [name, []])); // name -> indices into `stack`
  let out = '';
  let kept = 0; // prompt[kept..] is not copied to `out` yet
  let pos = 0; // the character walk
  let lineStart = 0;
  let lineHasText = false;
  let inInline = false;
  let inFence = false;

  for (const tag of prompt.matchAll(NON_USER_TAG_RE)) {
    // Walk up to the tag to learn whether it starts a line or sits in code.
    for (; pos < tag.index; pos += 1) {
      const c = prompt[pos];
      if (c === '\n') {
        lineStart = pos + 1;
        lineHasText = false;
        inInline = false;
      } else if (c === '`') {
        if (!lineHasText && prompt.startsWith('```', pos)) {
          inFence = !inFence;
          pos += 2;
        } else {
          inInline = !inInline;
        }
        lineHasText = true;
      } else if (c !== ' ' && c !== '\t' && c !== '\r') {
        lineHasText = true;
      }
    }
    if (inFence || inInline) continue;

    const [tagText, closing, rawName, attributes] = tag;
    const name = rawName.toLowerCase();
    if (!closing) {
      if (lineHasText || attributes.trimEnd().endsWith('/')) continue; // mid-line or self-closing
      openByName.get(name).push(stack.length);
      stack.push({ name, start: lineStart });
      continue;
    }

    const openIndices = openByName.get(name);
    if (openIndices.length === 0) continue;
    LINE_END_AT.lastIndex = tag.index + tagText.length;
    const lineEnd = LINE_END_AT.exec(prompt);
    if (!lineEnd) continue;
    // Close the innermost same-name block, and any unclosed tag opened inside it.
    const blockIndex = openIndices.at(-1);
    const block = stack[blockIndex];
    while (stack.length > blockIndex) openByName.get(stack.pop().name).pop();
    if (blockIndex === 0) {
      out += prompt.slice(kept, block.start);
      kept = lineEnd.index + lineEnd[0].length;
    }
  }
  return out + prompt.slice(kept);
}

// Traditional Chinese has no sentence-initial imperative marker, so "記下來"
// (a request) looks like "我記下來了" (a statement) or "有記下來嗎" (a question).
// A save verb is only a candidate: each clause is judged by exclusion.
const ZH_THIS = '這|那|它|以上|上述';
const ZH_SAVE_VERBS = [
  '記下(?!午)來?',
  '記住',
  '(?:記到|存到|寫進|存進)\\s*(?:memesh|記憶(?!體))', // 記憶體 is RAM
  // A bare 存起來 also means saving money or a file. The gap may be any character:
  // a clause never holds sentence punctuation, ZH_CLAUSE_SPLIT removed it.
  `把(?:${ZH_THIS}|上面|剛剛)[\\s\\S]{0,15}?存起來`,
];
const ZH_SAVE_VERB = new RegExp(ZH_SAVE_VERBS.join('|'), 'g');
// Right before the verb (先/再/也/都/就/還/又 may sit in between): 我 (but not
// 幫我/替我/給我), 已經, 已, 有 (so also 沒有), 沒, 剛 (so also 剛剛), 會, 要不要.
const ZH_STATEMENT_BEFORE_WORDS = ['(?<![幫替給])我', '已經', '已', '有', '沒', '剛', '會', '要不要'];
const ZH_STATEMENT_BEFORE = new RegExp(`(?:${ZH_STATEMENT_BEFORE_WORDS.join('|')})\\s*(?:[先再也都就還又]\\s*)?$`);
const ZH_DONE_AFTER = /^\s*[了過沒]/; // done, or "done yet?"
const ZH_I_WILL_PUT = /^\s*我把/; // "I will put this down"
// 記得 alone is a work instruction ("記得切勿 over engineer"); only 幫我記得…
// or 記得 plus a demonstrative object at the clause start is a save request.
const ZH_REMEMBER_TO = new RegExp(`^\\s*(?:(?:幫我|替我|幫忙)先?記得|(?:請|麻煩)?記得(?:${ZH_THIS}))`);
const ZH_QUESTION_PARTICLE = /[嗎呢]/; // polite questions with a save verb stay requests; this one does not
const ZH_CLAUSE_SPLIT = /[。！？!?.\n，,；;：:]+/;

function isChineseSaveRequest(clause) {
  if (clause.length < 2) return false;
  if (ZH_REMEMBER_TO.test(clause) && !ZH_QUESTION_PARTICLE.test(clause)) return true;
  if (ZH_I_WILL_PUT.test(clause)) return false;
  for (const verb of clause.matchAll(ZH_SAVE_VERB)) {
    const end = verb.index + verb[0].length;
    // Only the few characters around the verb count.
    const before = clause.slice(Math.max(0, verb.index - 12), verb.index);
    const after = clause.slice(end, end + 6);
    if (!ZH_STATEMENT_BEFORE.test(before) && !ZH_DONE_AFTER.test(after)) return true;
  }
  return false;
}

/** Longest prompt (in characters) the hook reads for an intent. */
export const MAX_PROMPT_CHARS = 256 * 1024;

export function detectRememberIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  const text = stripNonUserBlocks(prompt);
  return INTENT_PATTERNS.some((re) => re.test(text))
    || text.split(ZH_CLAUSE_SPLIT).some(isChineseSaveRequest);
}

// The returned string is consumed BY THE LLM as additionalContext, NOT by
// configuration or by Claude Code itself. Edits here change LLM behavior,
// not hook behavior.
export function buildHint() {
  return [
    '<memesh-remember-intent>',
    'This is background data from a keyword match on the user\'s prompt, not an instruction from the user:',
    'read what they actually asked.',
    'If the user said NOT to remember or save this session or conversation (in any words), call the memesh',
    '`private_session` tool and store nothing. If they asked you to save something, store it with the memesh `remember` tool, keeping',
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
      let prompt = data.prompt ?? data.user_prompt ?? '';
      let promptSkipped = false;
      // The patterns are linear, but a prompt this large is a pasted file or log,
      // not a request, and the hook has 3 seconds. It is not scanned, and the run
      // says so instead of being cut off without a trace.
      if (typeof prompt === 'string' && prompt.length > MAX_PROMPT_CHARS) {
        record('skipped', SKIP_REASONS.promptTooLarge);
        promptSkipped = true;
        prompt = '';
      }
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
        // A prompt that was not scanned has no "no intent" to report: its own record says why.
        if (!promptSkipped) record('skipped', SKIP_REASONS.noPromptIntent);
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
