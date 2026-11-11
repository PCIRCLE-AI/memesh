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
import { hookNodeProblem, NODE_TOO_OLD_REASON } from './_shared.js';
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
//     breaks, which for a long prompt is far past the hook's 3 s budget. Tabs,
//     carriage returns and no-break spaces after a sentence end still count.
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
// a line; same-name blocks nest, and a block inside an opening tag that never
// closes is still removed. Everything else is the user's own text and is kept:
// an unclosed tag (probably quoted), a tag mid-line (so also one in `inline
// code`), a self-closing tag, a mismatched closing tag.
// Backticks are not looked at: a code fence inside a block's body, or one the
// user left open above it, must not decide where a block ends. A block the
// user quotes inside a fence is removed too, which can only hide a request.
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
  const removed = []; // closed blocks as { start, end }, in prompt order, none inside another
  let pos = 0; // the character walk
  let lineStart = 0;
  let lineHasText = false;

  for (const tag of prompt.matchAll(NON_USER_TAG_RE)) {
    // Walk up to the tag to learn whether it starts a line.
    for (; pos < tag.index; pos += 1) {
      const c = prompt[pos];
      if (c === '\n') {
        lineStart = pos + 1;
        lineHasText = false;
      } else if (c !== ' ' && c !== '\t' && c !== '\r') {
        lineHasText = true;
      }
    }

    const [tagText, closing, rawName, attributes] = tag;
    const name = rawName.toLowerCase();
    if (!closing) {
      if (lineHasText || attributes.trimEnd().endsWith('/')) continue; // mid-line or self-closing
      openByName.get(name).push(stack.length);
      stack.push({ name, start: lineStart });
      continue;
    }

    const blockIndex = openByName.get(name).at(-1);
    LINE_END_AT.lastIndex = tag.index + tagText.length;
    const lineEnd = LINE_END_AT.exec(prompt);
    if (blockIndex === undefined || !lineEnd) continue;
    // Close the innermost same-name block, and any unclosed tag opened inside it.
    const { start } = stack[blockIndex];
    while (stack.length > blockIndex) openByName.get(stack.pop().name).pop();
    while (removed.at(-1)?.start >= start) removed.pop(); // blocks inside this one
    removed.push({ start, end: lineEnd.index + lineEnd[0].length });
  }

  let out = '';
  let kept = 0;
  for (const block of removed) {
    out += prompt.slice(kept, block.start);
    kept = block.end;
  }
  return out + prompt.slice(kept);
}

// Traditional Chinese has no sentence-initial imperative marker, so "記下來"
// (a request) looks like "我記下來了" (a statement) or "有記下來嗎" (a question).
// Each clause is judged on its own; when unsure, it is not a request.
const ZH_THIS = '這|那|它|以上|上述';
// A demonstrative and what may follow it in the same noun phrase: 這件事,
// 那個, 以上三點, 上述規則, 這段對話. Anything longer (這個函式) is a new topic.
const ZH_THIS_PHRASE = `(?:${ZH_THIS})(?:[一兩二三四五六七八九十幾]?[個件點條段些項句])?(?:事情?|規則|內容|討論|對話|重點|決定)?`;
const ZH_SAVE_VERBS = [
  // 記下來, or 記下 before a demonstrative or the clause end (not 筆記下載, 標記下一個).
  `記下(?:來|(?=${ZH_THIS})|\\s*$)`,
  // 記憶 only as the store itself (not 記憶體, 記憶卡, 記憶區塊).
  '(?:記到|存到|寫進|存進)\\s*(?:memesh|記憶(?=[\\s裡中吧喔好謝]|$))',
  // A bare 存起來 also means saving money or a file: the object must be this conversation.
  `把(?:${ZH_THIS_PHRASE}|(?:上面|剛剛)的?(?:內容|討論|對話|重點))[都也]?存起來`,
];
const ZH_SAVE_VERB = new RegExp(ZH_SAVE_VERBS.join('|'), 'g');
// What makes a clause with a save verb a statement or someone else's story.
const ZH_STATEMENT = {
  // At the clause start: 我把…, 他把…, 她們把… tell what someone put down.
  start: /^\s*(?:我|[他她]們?)把/,
  // Right before the verb, with 先/再/也/都/就/還/又 allowed in between: the
  // speaker or a third person (not 幫我/替我/給我, not 其他), 已經, 已, 有 (so also
  // 沒有), 沒, 剛 (so also 剛剛), 會, or 叫我們/叫你們/叫大家 (an order to others).
  before: new RegExp(`(?:(?<![幫替給其])(?:我|[他她]們?)|已經|已|有|沒|剛|會|叫(?:我們|你們|大家))\\s*(?:[先再也都就還又]\\s*)?$`),
  // Right after the verb: done, or "done yet?".
  after: /^\s*[了過沒]/,
};
// A question asks whether to save (要記下來嗎, 記下來？, the A-not-A forms
// 要不要/該不該/是不是) unless it is a polite request (可以幫我記下來嗎,
// 能不能記下來, 記下來好嗎).
const ZH_QUESTION = /[嗎呢]|(\p{Script=Han})不\1/u;
const ZH_POLITE = /幫|可以|能不能|好嗎/;
// 記得 alone is a work instruction (記得切勿 over engineer, 記得這個函式要改).
// It asks to save as 幫我記得… or with a demonstrative that ends the clause
// (記得這件事); 記住 the same way, or before a colon (請記住：部署前要備份).
const ZH_REMEMBER_FOR_ME = /^\s*(?:幫我|替我|幫忙)先?(?:記得|記住)/;
const ZH_REMEMBER_THIS = new RegExp(`^\\s*(?:請|麻煩)?(?:記得|記住)${ZH_THIS_PHRASE}\\s*$`);
const ZH_REMEMBER_BEFORE_COLON = /^\s*(?:請|麻煩)?記住\s*$/;
const ZH_CLAUSE = /[^。！？!?.\n，,；;：:]+/g;

// `next` is the punctuation mark that ends the clause, if any.
function isChineseSaveRequest(clause, next) {
  const asks = ZH_QUESTION.test(clause) || next === '？' || next === '?';
  if (asks && !ZH_POLITE.test(clause)) return false;
  if (ZH_REMEMBER_FOR_ME.test(clause) || ZH_REMEMBER_THIS.test(clause)) return true;
  if (ZH_REMEMBER_BEFORE_COLON.test(clause)) return next === '：' || next === ':';
  if (ZH_STATEMENT.start.test(clause)) return false;
  for (const verb of clause.matchAll(ZH_SAVE_VERB)) {
    const end = verb.index + verb[0].length;
    // Only the few characters before the verb count: ZH_STATEMENT.before ends
    // in $, so an unbounded slice would be rescanned for every verb.
    const before = clause.slice(Math.max(0, verb.index - 12), verb.index);
    if (!ZH_STATEMENT.before.test(before) && !ZH_STATEMENT.after.test(clause.slice(end))) return true;
  }
  return false;
}

/** Longest prompt (in characters) the hook reads for an intent. */
export const MAX_PROMPT_CHARS = 256 * 1024;

export function detectRememberIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  const text = stripNonUserBlocks(prompt);
  if (INTENT_PATTERNS.some((re) => re.test(text))) return true;
  for (const clause of text.matchAll(ZH_CLAUSE)) {
    if (isChineseSaveRequest(clause[0], text[clause.index + clause[0].length])) return true;
  }
  return false;
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
      // On a Node that cannot run MeMesh the hints below would send the agent to tools that always fail.
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
