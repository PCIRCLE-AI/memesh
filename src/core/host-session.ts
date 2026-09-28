// =============================================================================
// Which host session is this process running in? (#497)
// =============================================================================
//
// Every session of one principal shares its inbox, so a message can be meant
// for one session of it (`intended_session`). That id has to be a string the
// hooks, the router and the process recording intake all know:
//   - Claude Code starts its MCP servers (and shell commands) with
//     `CLAUDE_CODE_SESSION_ID`, equal to the `session_id` its hooks receive.
//   - Codex sets `CODEX_THREAD_ID` only for commands it runs in its shell, not
//     for its MCP servers; it equals the thread id its hooks receive as
//     `session_id` and `codex-session.ts` registers as `session_instance_id`.
//     So a Codex session records intake for such a message with the CLI.

import { agentScopeIdRejection, canonicalAgentScopeId } from './agent-scope-id.js';

/**
 * The session a caller of the message tool (MCP or CLI) is running in:
 * `CLAUDE_CODE_SESSION_ID`, else `CODEX_THREAD_ID`, in the canonical form
 * `intended_session` is stored in. Undefined when neither is set to something
 * a session id can be: the caller then has no session, which is not the same
 * as being every session.
 */
export function hostSessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return claudeCodeSessionFromEnv(env) ?? sessionFromVariable(env, 'CODEX_THREAD_ID');
}

/**
 * `CLAUDE_CODE_SESSION_ID` alone, for the Claude channel host: it registers
 * a Claude Code session and must never take a Codex id.
 */
export function claudeCodeSessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return sessionFromVariable(env, 'CLAUDE_CODE_SESSION_ID');
}

function sessionFromVariable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const session = canonicalAgentScopeId(raw);
  if (agentScopeIdRejection(name, session) === null) return session;
  // Set but unusable: say so, or "no session" reads exactly like "not set".
  // The variable only, never its value.
  try {
    process.stderr.write(`[memesh] ignoring ${name}: set but not a valid session id\n`);
  } catch { /* stderr gone */ }
  return undefined;
}
