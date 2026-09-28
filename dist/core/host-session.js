import { agentScopeIdRejection, canonicalAgentScopeId } from './agent-scope-id.js';
export function hostSessionFromEnv(env = process.env) {
    return claudeCodeSessionFromEnv(env) ?? sessionFromVariable(env, 'CODEX_THREAD_ID');
}
export function claudeCodeSessionFromEnv(env = process.env) {
    return sessionFromVariable(env, 'CLAUDE_CODE_SESSION_ID');
}
function sessionFromVariable(env, name) {
    const raw = env[name]?.trim();
    if (!raw)
        return undefined;
    const session = canonicalAgentScopeId(raw);
    if (agentScopeIdRejection(name, session) === null)
        return session;
    try {
        process.stderr.write(`[memesh] ignoring ${name}: set but not a valid session id\n`);
    }
    catch { }
    return undefined;
}
//# sourceMappingURL=host-session.js.map