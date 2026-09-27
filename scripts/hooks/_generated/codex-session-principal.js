// ============================================================================
// AUTO-GENERATED from src/core/codex-session-principal.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import { realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidCodexThreadId(value) {
    return typeof value === 'string' && CODEX_THREAD_ID.test(value);
}
export function automaticCodexSessionPrincipal(session) {
    return `codex-thread-${session.threadId}`;
}
export function resolveCodexSessionPrincipal(config, session, realpath = realpathSync) {
    if (config !== undefined) {
        const configuredWorkspace = resolveExistingConfiguredWorkspace(config.workspace, realpath);
        if (configuredWorkspace !== null && configuredWorkspace === session.workspace) {
            return { source: 'configured', principalId: config.principal_id };
        }
    }
    return { source: 'automatic', principalId: automaticCodexSessionPrincipal(session) };
}
function resolveExistingConfiguredWorkspace(value, realpath) {
    const workspace = requiredAbsolutePath(value, 'workspace');
    try {
        const resolved = realpath(workspace);
        if (!statSync(resolved).isDirectory())
            throw new Error('workspace must be a directory.');
        return resolved;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function requiredAbsolutePath(value, field) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096) {
        throw new Error(`${field} must be a bounded non-empty string.`);
    }
    if (!isAbsolute(value))
        throw new Error(`${field} must be an absolute path.`);
    return value;
}
