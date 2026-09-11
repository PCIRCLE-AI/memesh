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

const DECISION_CUES: RegExp[] = [
  /\b(?:we|i)(?:'ve| have|'ll| will)?\s+(?:decided|chosen|chose|settled on|opted)\b/i,
  /\b(?:decided|decision)\s*(?:is|was|:)\s*/i,
  /\blet'?s\s+(?:go with|use|switch to|stick with|keep)\b/i,
  /\b(?:going|go) with\b.{0,60}\binstead\b/i,
  /\bfrom now on\b/i,
  /決定|改用|就用|選擇了|拍板/,
];

const LESSON_CUES: RegExp[] = [
  /\blesson(?:s)? learned\b|\blesson:\s*/i,
  /\broot cause\b/i,
  /\bturn(?:s|ed) out\b/i,
  /\bthe (?:fix|problem|bug|issue) (?:was|is)\b/i,
  /\b(?:gotcha|pitfall)\b/i,
  /\bnext time\b/i,
  /教訓|根因|原來是|踩到|下次要/,
];

/**
 * Classify a turn. Returns null for ordinary conversation.
 * Decision cues are checked first: a turn that both decides and explains a
 * root cause is stored once, as the decision.
 */
export function classifyTurn(userText: string, assistantText: string): TurnSignal | null {
  const text = `${userText}\n${assistantText}`;
  for (const [kind, cues] of [['decision', DECISION_CUES], ['lesson', LESSON_CUES]] as const) {
    for (const re of cues) {
      const m = re.exec(text);
      if (m) return { kind, cue: m[0].trim() };
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
