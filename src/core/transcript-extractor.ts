// Visible transcript parsing for bounded agent work packages.

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface RawEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

const META_USER_PREFIX = /^<(local-command|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|user-memory-input|system-reminder)/;

function textFromAssistantBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: unknown };
    // Only visible text is eligible; private thinking and tool blocks are excluded.
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push(b.text.trim());
  }
  return out;
}

function textFromUserContent(content: unknown): string[] {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed || META_USER_PREFIX.test(trimmed)) return [];
    return [trimmed];
  }
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: unknown };
      // A user entry whose blocks are tool_result is the model's own tool
      // output echoed back — pure mechanics. Keep only genuine text blocks.
      if (b.type === 'text' && typeof b.text === 'string') out.push(...textFromUserContent(b.text));
    }
    return out;
  }
  return [];
}

function parseConversationContent(content: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      continue; // one bad line must not abort the transcript
    }
    if (entry.type === 'assistant') {
      for (const text of textFromAssistantBlocks(entry.message?.content)) {
        turns.push({ role: 'assistant', text });
      }
    } else if (entry.type === 'user') {
      for (const text of textFromUserContent(entry.message?.content)) {
        turns.push({ role: 'user', text });
      }
    }
  }
  return turns;
}

export function parseVisibleConversation(transcript: Buffer): ConversationTurn[] {
  return parseConversationContent(transcript.toString('utf8'));
}
