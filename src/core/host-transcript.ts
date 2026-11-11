/**
 * Reading one row of a host's own transcript, for the places that must agree on
 * what a row says: the Stop hook's session summary, the remember nudge and the
 * handoff all read rows. The Codex layout used to be defined in more than one
 * place (the rollout reader knew `function_call` and `custom_tool_call`, the nudge
 * and the handoff did not read Codex rows at all); it is defined here once.
 *
 * Codex rows, as the host writes them:
 *  - a tool request: `{ type: 'response_item', payload: { type: 'function_call' | 'custom_tool_call', … } }`
 *  - a message: `{ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'output_text' | 'input_text', text }] } }`
 *
 * Runtime-leaf (no imports), mirrored for the hooks by scripts/generate-hook-core.mjs.
 */

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A Codex rollout file (`rollout-<time>-<thread>.jsonl`, plain or archived `.zst`): Codex keeps no notes folder of its own. */
export function isCodexRollout(transcriptPath: unknown): boolean {
  return typeof transcriptPath === 'string' && /(?:^|[\\/])rollout-[^\\/]*\.jsonl(?:\.zst)?$/.test(transcriptPath);
}

/** Is this rollout row a Codex tool request? The one definition of "a tool call" there. */
export function isCodexToolRequest(entry: unknown): boolean {
  const row = record(entry);
  const payload = record(row?.payload);
  return row?.type === 'response_item' && (payload?.type === 'function_call' || payload?.type === 'custom_tool_call');
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
