// chat-turn — store one chat turn of a host that only reports turns (Hermes Agent).
//
// Every turn is kept, in full, as two `conversation` records: what the user said and what the assistant answered.
// Nothing here decides whether a turn is worth keeping, and nothing reads the words to classify it: what was said
// is memory, and a later session can search it.

import { randomUUID } from 'crypto';
import { redactSecrets } from './paths.js';
import { remember } from './operations.js';
import { MEMORY_DATA_NOTICE } from './work-topology.js';
import { AGENT_TEXT_OMITTED, omitAgentMessageText } from './session-handoff.js';

/** The block Hermes' prefetch() puts in front of the user's text: earlier memories, not something the user said. */
const RECALL_BLOCK = /^\s*\[MeMesh recall\][\s\S]*?(?:\n\s*\n|$)/;

function withoutRecall(text: string): string {
  if (!text.startsWith(`${MEMORY_DATA_NOTICE}\n`)) return text.replace(RECALL_BLOCK, '');
  const start = MEMORY_DATA_NOTICE.length + 1;
  const lineEnd = text.indexOf('\n', start);
  const fence = /^(`{3,})text$/.exec(text.slice(start, lineEnd))?.[1];
  if (!fence) return text;
  const close = text.indexOf(`\n${fence}`, lineEnd);
  if (close < 0) return text;
  const rest = text.slice(close + fence.length + 1);
  // Only an exact, complete leading context block is removable.
  return rest === '' || rest.startsWith('\n\n') ? rest.trimStart() : text;
}

/** Only exact leading envelopes supplied by this session's inbox are context, never user prose. */
function withoutReceivedMessages(text: string, envelopes: readonly string[]): string {
  let rest = text;
  // Inbox history includes already-read rows. Remove only an exact canonical
  // envelope actually leading this turn; a different historical row must not
  // prevent a newer injected one from being recognised.
  while (true) {
    const envelope = envelopes.find(candidate => candidate !== '' && rest.startsWith(candidate));
    if (!envelope) return rest;
    rest = rest.slice(envelope.length);
  }
}

/** The title of a record is the first line of what was said, cut at this length. */
const TITLE_MAX_CHARS = 120;

export interface ChatTurnCaptureResult {
  outcome: 'wrote' | 'skipped';
  reason?: string;
  names?: string[];
}

/**
 * Store a turn as up to two `conversation` entities, one per side that has text.
 * Each event gets its own identity, including repeated words in a later turn.
 */
export function captureChatTurn(input: {
  sessionId: string;
  userText: string;
  assistantText: string;
  sourceHost: string;
  namePrefix: string;
  baseTags: string[];
  /** Canonical envelopes injected before the prompt, scoped by the caller's own inbox. */
  receivedMessages?: readonly { envelope: string; body: string }[];
}): ChatTurnCaptureResult {
  const turnId = randomUUID();
  const received = input.receivedMessages ?? [];
  const envelopes = received.flatMap(message => [message.envelope, redactSecrets(message.envelope)]);
  const bodies = received.flatMap(message => [message.body, redactSecrets(message.body)]);
  const assistant = omitAgentMessageText(redactSecrets(input.assistantText), bodies);
  const onlyOmissions = assistant.omitted > 0
    && assistant.text.replaceAll(AGENT_TEXT_OMITTED, '').trim() === '';
  const sides: Array<['user' | 'assistant', string]> = [
    ['user', withoutReceivedMessages(withoutRecall(input.userText), envelopes)],
    // A response that is only a removed quotation carries no new Hermes knowledge.
    ['assistant', onlyOmissions ? '' : assistant.text],
  ];
  const names: string[] = [];
  for (const [role, said] of sides) {
    if (said.trim() === '') continue;
    const text = redactSecrets(said);
    const name = `${input.namePrefix}-${input.sessionId}-${turnId}-${role}`;
    remember({
      name,
      type: 'conversation',
      title: text.split('\n').find((line) => line.trim() !== '')!.trim().slice(0, TITLE_MAX_CHARS),
      observations: [text],
      tags: [...input.baseTags, `session:${input.sessionId}`, `role:${role}`],
      sourceHost: input.sourceHost,
    });
    names.push(name);
  }
  return names.length > 0 ? { outcome: 'wrote', names } : { outcome: 'skipped', reason: 'the turn has no text' };
}
