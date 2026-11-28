// Codex thread-id validation shared with the plan activity hook.
// The generated hook mirror keeps the same validation without importing dist.
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `value` shaped like a Codex thread/session id? */
export function isValidCodexThreadId(value: unknown): value is string {
  return typeof value === 'string' && CODEX_THREAD_ID.test(value);
}
