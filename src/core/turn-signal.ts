// turn-signal — decide whether one chat turn is worth a memory.
//
// Hermes Agent's `sync_turn()` used to store EVERY turn as a `conversation`
// entity: high volume, low signal. A turn is kept now only when its text
// carries a decision-shaped or lesson-shaped move — the same two kinds the
// Claude Code nudges ask the agent to `remember`. The Claude side detects
// those from tool events (ExitPlanMode accepted, AskUserQuestion answered);
// a chat host's turn hook sees only the user and assistant text, so this is
// a text classifier over the same two kinds, not a shared implementation.
//
// Deliberately conservative: a false negative costs one unstored turn (the
// explicit memesh_remember tool remains), a false positive puts chatter back
// into the graph — the thing this exists to stop.

import { createHash } from 'crypto';
import { redactSecrets } from './paths.js';
import { remember } from './operations.js';

export type TurnSignalKind = 'decision' | 'lesson';

export interface TurnSignal {
  kind: TurnSignalKind;
  /** The phrase that matched, for the stored tag/receipt. */
  cue: string;
}

// Cues run on the ASSISTANT text only. The user text carries questions
// ("have we decided yet?"), apologies ("I chose the wrong file") and — in
// Hermes — the `[MeMesh recall]` block prefetch() injected, which repeats
// earlier decisions verbatim: classifying it made every later turn a
// "decision" (a feedback loop the per-turn digest could not dedupe).
//
// Measured against twelve real turns in review (#326 F1); each cue below is
// there because one of them needed it, and "turns out", "next time" and
// "the issue is" were removed because they matched ordinary replies.
const DECISION_CUES: RegExp[] = [
  /\b(?:we|i)(?:'ve| have|'ll| will)?\s+(?:decided|settled on|opted)\b/gi,
  /\bdecision\s*:/gi,
  /\blet'?s\s+(?:go with|use|switch to|stick with)\b/gi,
  /\bi(?:'ll| will)\s+go with\b/gi,
  /\bwe(?:'re| are|'ll| will)\s+(?:going to\s+)?(?:use|go with|switch to|stick with)\b/gi,
  /(?:^|[.!?;]\s+)use\s+[^.!?\n]{1,40}?\binstead of\b/gi,
  /(?:^|[.!?;]\s+)switching to\b/gi,
  /^\s*agreed\s*[:,—-]/gim,
  /\bfrom now on\b/gi,
  // 決定 alone is an ordinary verb (「根據 flag 決定要不要重試」); only its
  // object form states a choice.
  /決定(?:用|採用|改|不|要用|走)|改用|就用|選擇了|拍板/g,
];

const LESSON_CUES: RegExp[] = [
  /\blessons? learned\b|\blesson\s*:/gi,
  /\blearned the hard way\b/gi,
  /\broot cause\b/gi,
  /\bthe (?:fix|problem|bug) was\b/gi,
  /\b(?:gotcha|pitfall)\b/gi,
  /教訓|根因|原來是|踩到|下次要/g,
];

// "not yet decided", "haven't settled on", "還沒決定": a cue preceded by one
// of these within 20 characters — and within the same clause — is the
// opposite of a decision. The clause limit keeps "No — we decided …" and
// "沒有問題，決定用 …" counted.
const NEGATION = /\b(?:not|no|never|haven'?t|hasn'?t|didn'?t|won'?t)\b|還沒|尚未|沒有/i;
const NEGATION_WINDOW = 20;
const CLAUSE_BREAK = /[.!?;:—,，。；：]/g;

/** Text after the last clause break in `before`. */
function sameClause(before: string): string {
  let cut = 0;
  for (const m of before.matchAll(CLAUSE_BREAK)) cut = (m.index ?? 0) + m[0].length;
  return before.slice(cut);
}

/**
 * Remove what the assistant is SHOWING rather than saying: fenced code
 * blocks and quoted text ("…", “…”, 「…」, 『…』). A reply that quotes a
 * reviewer's "we decided to use X" has not decided anything.
 */
function stripShownText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/g, ' ');
}

/** Drop a leading `[MeMesh recall]` block (up to the first blank line). */
function stripRecallBlock(text: string): string {
  return text.replace(/^\s*\[MeMesh recall\][\s\S]*?(?:\n\s*\n|$)/, '');
}

function firstUnnegated(re: RegExp, text: string): string | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = sameClause(text.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index));
    if (!NEGATION.test(before)) return m[0].trim();
    if (m[0] === '') re.lastIndex++;
  }
  return null;
}

/**
 * Classify a turn from its assistant text. Returns null for ordinary
 * conversation. Decision cues are checked first: a turn that both decides and
 * explains a root cause is stored once, as the decision. `userText` is
 * accepted for the caller's convenience and deliberately not classified.
 */
export function classifyTurn(_userText: string, assistantText: string): TurnSignal | null {
  const text = stripShownText(stripRecallBlock(assistantText));
  for (const [kind, cues] of [['decision', DECISION_CUES], ['lesson', LESSON_CUES]] as const) {
    for (const re of cues) {
      const cue = firstUnnegated(re, text);
      if (cue !== null) return { kind, cue };
    }
  }
  return null;
}

/** Per-side cap on stored turn text — the same 2,000 chars the Hermes plugin used. */
export const TURN_TEXT_CAP = 2000;

export interface ChatTurnCaptureResult {
  outcome: 'wrote' | 'skipped';
  reason?: string;
  name?: string;
  kind?: TurnSignalKind;
}

/**
 * Store a turn as one `conversation` entity when it classifies, nothing
 * otherwise. The name is a digest of the turn text, so a host that retries
 * the same turn does not create a second row.
 */
export function captureChatTurn(input: {
  sessionId: string;
  userText: string;
  assistantText: string;
  sourceHost: string;
  namePrefix: string;
  baseTags: string[];
}): ChatTurnCaptureResult {
  const signal = classifyTurn(input.userText, input.assistantText);
  if (!signal) return { outcome: 'skipped', reason: 'no decision- or lesson-shaped move in this turn' };
  const digest = createHash('sha256')
    .update(input.userText).update('\0').update(input.assistantText)
    .digest('hex').slice(0, 12);
  const name = `${input.namePrefix}-${input.sessionId}-${digest}`;
  remember({
    name,
    type: 'conversation',
    // Redact before truncating, same as every other capture path. A side
    // with no text is left out rather than stored as a bare "User: ".
    observations: [
      ['User', input.userText],
      ['Assistant', input.assistantText],
    ].filter(([, t]) => t.trim() !== '').map(([who, t]) => `${who}: ${redactSecrets(t).slice(0, TURN_TEXT_CAP)}`),
    tags: [...input.baseTags, `session:${input.sessionId}`, `signal:${signal.kind}`],
    sourceHost: input.sourceHost,
  });
  return { outcome: 'wrote', name, kind: signal.kind };
}
