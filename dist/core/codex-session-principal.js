const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidCodexThreadId(value) {
    return typeof value === 'string' && CODEX_THREAD_ID.test(value);
}
//# sourceMappingURL=codex-session-principal.js.map