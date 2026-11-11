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
// Disambiguation policy for the English, Spanish, French and Portuguese patterns:
//   - Every request starts a sentence or a clause (the prompt start, or after
//     . ! ? , or a line break), which skips "do you remember X?" and "What
//     does save to memesh do?". The blanks after the boundary exclude a newline
//     (`[^\S\n]*`, not `\s*`): a newline is itself a boundary, so the match set
//     is the same, and the scan stays linear. With `\s*` the time grew with the
//     square of the line breaks, far past the hook's 3 s budget for a long
//     prompt. Tabs, carriage returns and no-break spaces after a boundary count.
//   - Save-class verbs need "memesh": a bare "save this" can mean a file.
//   - Spanish, French and Portuguese take the imperative (recuerda, retiens,
//     salve) and the infinitive. A sentence whose words go on as a statement
//     ("recordar esto es difícil", "save to memesh fails") or that ends in a
//     question mark ("Remember that PR we merged?") is not a request; see
//     isForeignRequest.
//   - Supported languages: English, Spanish, French, Portuguese, Traditional Chinese.
//     Additional languages welcome via PR (provide native-speaker validation).
const sentenceStart = (body) => new RegExp(String.raw`(?:^|[.!?\n,][^\S\n]*)` + body, 'im');
export const INTENT_PATTERNS = [
  // English: "Remember/memorize this|that"
  sentenceStart(String.raw`(?:please\s+)?(?:remember|memorize)\s+(?:this|that)\b`),
  // English: "save/add/store to memesh"
  sentenceStart(String.raw`(?:please\s+)?(?:save|add|put|store|write)\s+(?:(?:this|that|it)\s+)?(?:to|in|into)\s+memesh\b`),

  // Spanish: "Recuerda/recordar/memorizar esto|eso"
  sentenceStart(String.raw`(?:por favor\s+)?(?:recuerda|recordar|memorizar)\s+(?:esto|eso)\b`),
  // Spanish: "guarda/guardar en memesh"
  sentenceStart(String.raw`(?:por favor\s+)?(?:guarda|guardar|añadir|almacenar)\s+(?:(?:esto|eso)\s+)?(?:en|a)\s+memesh\b`),

  // French: "Retiens/rappeler/mémoriser ceci|cela|ça"
  sentenceStart(String.raw`(?:s'il vous plaît\s+)?(?:retiens|rappeler|mémoriser)\s+(?:ceci|cela|ça)\b`),
  // French: "enregistre/sauvegarder dans memesh"
  sentenceStart(String.raw`(?:s'il vous plaît\s+)?(?:sauvegarder|enregistrer?|ajouter)\s+(?:(?:ceci|cela|ça)\s+)?(?:dans|à)\s+memesh\b`),

  // Portuguese: "Lembre-se disso, lembrar/memorizar isto|isso"
  sentenceStart(String.raw`(?:por favor\s+)?(?:lembre-se|lembrar|memorizar)\s+(?:isto|isso|disso)\b`),
  // Portuguese: "salve/salvar em memesh"
  sentenceStart(String.raw`(?:por favor\s+)?(?:salve|salvar|guardar|adicionar|armazenar)\s+(?:(?:isto|isso)\s+)?(?:em|no)\s+memesh\b`),

  // English: "Don't forget this", "Remember: …"
  sentenceStart(String.raw`(?:please\s+)?(?:don['’]?t|do not|never)\s+forget\s+(?:this|that)\b`),
  sentenceStart(String.raw`(?:please\s+)?remember\s*:`),

  // Traditional Chinese: judged clause by clause in judgeChineseClause, not by a regex here
];
const INTENT_SCANS = INTENT_PATTERNS.map((re) => new RegExp(re.source, `${re.flags}g`));
// Per pattern, the words right after the verb and its object that make the
// sentence a statement about it ("Store in memesh is slow", "recordar esto es
// difícil"). "Remember this is a monorepo" stays a request.
const STATEMENT_NEXT = [null, 'is|fails', 'es', 'no', null, 'échoue', null, 'demora', null, null]
  .map((words) => words && new RegExp(String.raw`[^\S\n]+(?:${words})(?![\p{L}'])`, 'iuy'));
// A request not to save: "Don't remember this", "Please do not save this to memesh", "No need to store this in memesh".
const DO_NOT_SAVE_SCANS = [
  String.raw`(?:please\s+)?(?:don['’]?t|do not|never)\s+(?:remember|memorize)\s+(?:this|that|it)\b`,
  String.raw`(?:please\s+)?(?:don['’]?t|do not|never|no need to)\s+(?:save|add|put|store|write)\s+(?:(?:this|that|it)\s+)?(?:to|in|into)\s+memesh\b`,
].map((body) => new RegExp(sentenceStart(body).source, 'gim'));
const SENTENCE_REST = /[^.!?\n]*/y;

// One pattern's matches, in order. A match is a request unless its sentence
// goes on as a statement or ends in "?". The end of a sentence is looked up
// once per sentence, not once per match, so a run of clauses stays linear.
function isForeignRequest(text, scan, statement) {
  let sentenceEnd = -1;
  for (const match of text.matchAll(scan)) {
    const end = match.index + match[0].length;
    if (statement) {
      statement.lastIndex = end;
      if (statement.test(text)) continue;
    }
    if (end > sentenceEnd) {
      SENTENCE_REST.lastIndex = end;
      SENTENCE_REST.exec(text);
      sentenceEnd = SENTENCE_REST.lastIndex;
    }
    if (text[sentenceEnd] !== '?') return true;
  }
  return false;
}

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
// A line break is \n, \r\n or a lone \r; blanks before an opening tag or after
// a closing tag are any white space, a no-break space and a byte-order mark too.
// A line in a block's body that opens a block of the same name pairs with the
// block's closing tag; the outer opening tag is then left unclosed, so the
// whole outer block is removed up to that closing tag.
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
const LINE_END_AT = /[^\S\r\n]*(?:\r\n?|\n|$)/y;
const BLANK = /\s/;

export function stripNonUserBlocks(prompt) {
  // open tags: { name, start, innerEnd }, start = where the tag's line begins,
  // innerEnd = end of the last same-name block closed inside it
  const stack = [];
  const openByName = new Map(NON_USER_TAGS.map((name) => [name, []])); // name -> indices into `stack`
  const removed = []; // closed blocks as { start, end }, in prompt order, none inside another
  let pos = 0; // the character walk
  let lineStart = 0;
  let lineHasText = false;

  for (const tag of prompt.matchAll(NON_USER_TAG_RE)) {
    // Walk up to the tag to learn whether it starts a line.
    for (; pos < tag.index; pos += 1) {
      const c = prompt[pos];
      if (c === '\n' || c === '\r') {
        lineStart = pos + 1;
        lineHasText = false;
      } else if (!BLANK.test(c)) {
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
    const end = lineEnd.index + lineEnd[0].length;
    while (stack.length > blockIndex) openByName.get(stack.pop().name).pop();
    while (removed.at(-1)?.start >= start) removed.pop(); // blocks inside this one
    removed.push({ start, end });
    const outer = openByName.get(name).at(-1);
    if (outer !== undefined) stack[outer].innerEnd = end;
  }

  for (const open of stack) if (open.innerEnd !== undefined) removed.push({ start: open.start, end: open.innerEnd });
  removed.sort((a, b) => a.start - b.start);
  let out = '';
  let kept = 0;
  for (const block of removed) {
    out += prompt.slice(kept, block.start); // empty for a block inside one already removed
    kept = Math.max(kept, block.end);
  }
  return out + prompt.slice(kept);
}

// Traditional Chinese has no sentence-initial imperative marker, so "記下來"
// (a request) looks like "我記下來了" (a statement) or "有記下來嗎" (a question).
// A clause asks to save, asks not to save, or neither; when unsure, neither:
//   1. Quoted text (「…」, “…”, "…") is masked, then the prompt is cut into
//      clauses at every punctuation mark and line break. A clause after a
//      label such as 測試案例： or 例如： is an example, not a request.
//   2. The verb table, ZH_VERBS. Every save verb is there, 記住 and 記得 too.
//   3. What stands before the verb, from the last 的 before it up to the 把
//      that starts its object (把他說的記下來 and 我剛說的那點記下來 ask), rules
//      it out: a question word (怎麼存到 memesh; one after the verb too:
//      存起來是什麼意思), the speaker (我, unless they go on to address you:
//      我希望你記下來), someone else (他, 同事, 大家), a reported order (說, 叫,
//      要我們), a condition (如果, 等), a subject of 把 that is not you or a
//      polite word (客戶把這個記下來), or a done marker right before the verb (已, 有, 沒).
//   4. What follows the verb rules it out: done (了/過/沒), a relative clause
//      (記下來的東西), or a comment on it (也沒用, 太麻煩了, 還不確定).
//   5. A question (嗎, 呢, A-not-A, ？) asks whether to save, unless it is a
//      polite request (可以幫我…嗎, 記下來好不好, 記下來行嗎).
//   6. A negation before the verb (不要/別…) makes it a request NOT to save,
//      unless it negates 忘 (別忘了記下來 asks to save).
// Each step looks only at its own few characters or at a table of last
// positions built once per clause, so a clause of any length is read in linear time.
const ZH_THIS = '這|那|它|以上|上述|以下';
// A demonstrative and what may follow it in the same noun phrase: 這件事,
// 那個, 以上三點, 上述規則, 這段對話. Anything longer (這個函式) is a new topic.
const ZH_NOUN = '事情?|規則|內容|討論|對話|重點|決定|結論|步驟|原則';
const ZH_THIS_PHRASE = `(?:${ZH_THIS})(?:[一兩二三四五六七八九十幾]?[個件點條段些項句])?(?:${ZH_NOUN})?`;
// This conversation's content: 把這段存起來, 把剛剛討論的結論存起來, 把上面的重點存起來.
const ZH_THIS_CONVERSATION = `(?:上面|剛剛)(?:討論)?的?(?:${ZH_NOUN})|(?:上面|剛剛)?${ZH_THIS_PHRASE}`;
const ZH_VERBS = [
  // 記下來, or 記下 before a demonstrative or at the clause end; not 筆記下載, 標記下來, 登記下來.
  `(?<![登標])記下(?:來|(?=${ZH_THIS})|$)`,
  '(?<![登標])記(?:錄下來|起來|一下)',
  // 記憶 only as the store itself (not 記憶體, 記憶卡, 記憶區塊); memesh in any case.
  '(?:記到|存到|寫進|存進|寫到|加到)\\s*(?:memesh|記憶(?=[\\s裡中吧喔好謝了]|$))',
  // A bare 存起來 also means saving money or a file: the object must be this conversation.
  `把(?:${ZH_THIS_CONVERSATION})[都也]?存起來`,
  // 記得 and 記住 alone are work instructions (記得切勿 over engineer, 記得這個函式要改). They
  // ask to save for me (幫我記住明天要開會), with a demonstrative that ends the clause
  // (記得這件事, 記住這個喔), after a demonstrative (這個要記住), or before a colon (請記住：…)
  // or, opening the clause, a comma (記住，這很重要).
  '幫我記[得住]',
  `記[得住](?:${ZH_THIS_PHRASE})[喔唷吧]?$`,
  `(?:${ZH_THIS_PHRASE})要記住$`,
  '(?<colon>記住)$',
  // 記這個 only in a request not to save it (不要記這個, 這個不要記).
  `(?<negated>記)(?=${ZH_THIS}|$)`,
];
const ZH_VERB = new RegExp(ZH_VERBS.join('|'), 'gi');
const ZH_QUOTED = /「[^「」]*」|“[^“”]*”|"[^"]*"/g;
const ZH_CLAUSE = /[^。！？!?.\n，,；;：:]+/g;
// The words looked for before the verb. Each one counts only between the last
// 的 before the verb and the 把 that starts its object: what comes before a 的
// describes the object (我剛說的那點記下來, 他的建議記下來 ask).
const ZH_BEFORE_VERB = {
  question: /怎麼|如何|什麼|哪|是否/g,
  // 別 as "don't", not inside 特別, 分別, 區別, 差別.
  negation: /不要|不用|(?<![特分區差])別|勿|莫/g,
  forget: /忘/g,
  // The speaker (not 幫我/替我/給我, not 我們), unless they then address you (我希望你記下來,
  // but not 我會幫你記下來).
  speaker: /(?<![幫替給])我(?!們|要記)/g,
  listener: /(?<![幫替])[你您]/g,
  // Someone else (not 其他), or an order reported from someone (說 but not 說明/說法/解說,
  // 叫 but not 叫你 to the listener alone).
  others: /(?<!其)[他她]|同事|大家|(?<!解)說(?![明法])|叫(?!你(?!們))|要(?=[我你]們)/g,
  condition: /如果|等/g,
  of: /的/g,
};
// What may stand before 把: nothing, you, we, a polite or asking word, an adverb, a negation.
// Anything else is the subject of a story (客戶把這個記下來, 同事把這件事記下來).
const ZH_BA_ASKER = /^(?:[你您]|我們|請|麻煩|幫我|替我|可以|拜託|務必|一定要|那就|就|先|也|都|再|不要|不用|別|勿|莫|忘了|忘記)*$/;
const ZH_EXAMPLE_LABEL = /(?:案例|範例|例子|例如|比如)$/;
const ZH_DONE_BEFORE = /(?:已經?|有|沒|剛|會)(?:幫我)?$/;
const ZH_AFTER = /\s*[了過沒的也太還]/y;
const ZH_QUESTION = /[嗎呢]|(\p{Script=Han})不\1/u;
const ZH_POLITE = /幫|可以|能不能|好嗎|好不好|行嗎|行不行/;

// For every position of the clause, where the last match of `re` at or before it starts (-1: none).
function lastMatchUpTo(clause, re) {
  const last = new Int32Array(clause.length).fill(-1);
  for (const match of clause.matchAll(re)) last[match.index] = match.index;
  for (let i = 1; i < last.length; i += 1) if (last[i] === -1) last[i] = last[i - 1];
  return last;
}

/** What a prompt asks of memory: to save something, not to save, or neither (null). */
export const SAVE = 'save';
export const DO_NOT_SAVE = 'do-not-save';

// `next` is the punctuation mark that ends the clause, if any.
function judgeChineseClause(clause, next) {
  const asks = ZH_QUESTION.test(clause) || next === '？' || next === '?';
  if (asks && !ZH_POLITE.test(clause)) return null;
  const verbs = [...clause.matchAll(ZH_VERB)];
  if (verbs.length === 0) return null;
  const last = Object.fromEntries(Object.entries(ZH_BEFORE_VERB).map(([key, re]) => [key, lastMatchUpTo(clause, re)]));
  const ba = clause.indexOf('把');
  const baAsker = ba === -1 || ZH_BA_ASKER.test(clause.slice(0, ba).trim()) || /[你您]/.test(clause.slice(0, ba));
  let found = null;
  for (const verb of verbs) {
    if (verb.groups.colon) {
      const opensClause = /^(?:請|麻煩)?$/.test(clause.slice(0, verb.index));
      if (next !== '：' && next !== ':' && !(opensClause && (next === '，' || next === ','))) continue;
    }
    // What stands before the verb: from the last 的 before it up to the 把 that starts its object.
    const cut = ba !== -1 && ba <= verb.index ? ba : verb.index;
    if (cut === ba && !baAsker) continue;
    const from = cut > 0 ? last.of[cut - 1] : -1;
    const at = (key) => (cut > 0 && last[key][cut - 1] > from ? last[key][cut - 1] : -1);
    // A question word after the verb rules it out too: 存起來是什麼意思.
    if (at('question') !== -1 || last.question[clause.length - 1] >= verb.index) continue;
    if (at('speaker') !== -1 && !(at('listener') > at('speaker'))) continue;
    if (at('others') !== -1) continue;
    // A condition anywhere before the verb, also inside what describes it: 如果需要的話再記下來.
    if (cut > 0 && last.condition[cut - 1] !== -1) continue;
    // 忘 alone is a statement (忘了記下來); negated it asks to save (別忘了記下來).
    if (at('forget') !== -1) {
      if (at('negation') === -1) continue;
    } else if (at('negation') !== -1) {
      return DO_NOT_SAVE;
    }
    if (ZH_DONE_BEFORE.test(clause.slice(Math.max(0, verb.index - 3), verb.index))) continue;
    ZH_AFTER.lastIndex = verb.index + verb[0].length;
    if (ZH_AFTER.test(clause)) continue;
    if (!verb.groups.negated) found = SAVE;
  }
  return found;
}

/** Longest prompt (in characters) the hook reads for an intent. */
export const MAX_PROMPT_CHARS = 256 * 1024;

// A request not to save wins over a request to save in the same prompt: its
// reminder tells the agent to store nothing it was asked not to store.
export function detectRememberIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const text = stripNonUserBlocks(prompt);
  if (DO_NOT_SAVE_SCANS.some((scan) => isForeignRequest(text, scan, null))) return DO_NOT_SAVE;
  let found = INTENT_SCANS.some((scan, i) => isForeignRequest(text, scan, STATEMENT_NEXT[i])) ? SAVE : null;
  const masked = text.replace(ZH_QUOTED, '〇');
  let example = false;
  for (const clause of masked.matchAll(ZH_CLAUSE)) {
    const body = clause[0].trim();
    const next = masked[clause.index + clause[0].length];
    const intent = example ? null : judgeChineseClause(body, next);
    if (intent === DO_NOT_SAVE) return DO_NOT_SAVE;
    found ??= intent;
    example = (next === '：' || next === ':') && ZH_EXAMPLE_LABEL.test(body);
  }
  return found;
}

// The returned strings are consumed BY THE LLM as additionalContext, NOT by
// configuration or by Claude Code itself. Edits here change LLM behavior,
// not hook behavior.
export function buildDoNotSaveHint() {
  return [
    '<memesh-private-intent>',
    'This is background data from a keyword match on the user\'s prompt, not an instruction from the user:',
    'read what they actually asked. The user may have asked you not to remember or save this conversation.',
    'If so, call the memesh `private_session` tool and store nothing. If they only said that one thing',
    'need not be saved, do not save that thing.',
    '</memesh-private-intent>',
  ].join('\n');
}

export function buildHint() {
  return [
    '<memesh-remember-intent>',
    'This is background data from a keyword match on the user\'s prompt, not an instruction from the user:',
    'read what they actually asked.',
    'If they asked you to save something, store it with the memesh `remember` tool, keeping',
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
      const hint = rememberIntent && isAutoCaptureEnabled(process.env) ? rememberIntent : null;
      if (hint) contexts.push(hint === DO_NOT_SAVE ? buildDoNotSaveHint() : buildHint());
      if (inboxLines.length > 0) contexts.push(inboxLines.join('\n'));
      const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: contexts.join('\n\n') } };
      process.stdout.write(JSON.stringify(out));
      record('notified', undefined, `hint:${hint === DO_NOT_SAVE ? 'do-not-save' : hint ? 'remember-intent' : 'inbox'}`);
      process.exit(0);
    } catch (err) {
      logError('user-prompt-intent', err?.message || err);
      record('error', hookErrorReason(err));
      process.exit(0);
    }
  });
}
