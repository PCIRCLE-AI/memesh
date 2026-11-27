/** Read host transcript rows used for assistant conversation capture. */

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The text of a Codex assistant message row (its `output_text` blocks joined),
 * '' for an assistant message that carries none, and null when the row is not
 * a Codex assistant message at all.
 */
export function codexAssistantText(entry: unknown): string | null {
  const row = record(entry);
  const payload = record(row?.payload);
  if (row?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'assistant') return null;
  const content = payload.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => { const b = record(block); return b?.type === 'output_text' && typeof b.text === 'string' ? b.text : ''; })
    .filter((text) => text !== '')
    .join('\n');
}
