import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeCodeSessionFromEnv } from '../core/host-session.js';
import { getAgentRouterSocketPath, getMemeshDirFromDbPath, normalizeAgentRouterSocketPath } from '../core/paths.js';
import { requirePrivateWritableDirectory } from '../core/file-mode.js';
import { resolveMcpProject } from '../transports/mcp/project-context.js';
import { ensureRouterTokenFile } from './config.js';
import { connectRouterHost, type RouterHostConnection } from './router-client.js';

/** Ordinary Claude MCP lifecycle, not a Channel or a second notification path. */
export async function startClaudeInboxPresence(rootUris: readonly string[] | null): Promise<RouterHostConnection | undefined> {
  if (process.platform === 'win32') return undefined;
  const session = claudeCodeSessionFromEnv();
  if (!session) throw new Error('Claude online registration skipped: no valid CLAUDE_CODE_SESSION_ID.');
  const binding = resolveMcpProject(process.env.MEMESH_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR, rootUris);
  if ('error' in binding) throw new Error(`Claude online registration skipped: ${binding.reason}`);

  // Reuse exactly the hook's recipient/config validation, including explicit
  // opt-out and invalid owner config. This path is also correct in the MCP bundle.
  const hookUrl = new URL('../../scripts/hooks/_shared.js', import.meta.url).href;
  const hooks = await import(hookUrl) as {
    resolveMessageRecipient(env: NodeJS.ProcessEnv): string | undefined;
  };
  const principal = hooks.resolveMessageRecipient({ ...process.env, MEMESH_HOOK_HOST: 'claude-code' });
  if (!principal) return undefined;
  const dataDir = getMemeshDirFromDbPath();
  requirePrivateWritableDirectory(dataDir, 'the local router keeps its lifecycle state there');
  const token = ensureRouterTokenFile(path.join(dataDir, 'agent-router.token'));
  return connectRouterHost({
    socket_path: normalizeAgentRouterSocketPath(process.env.MEMESH_ROUTER_SOCKET ?? getAgentRouterSocketPath()),
    auth_token: token,
    identity: {
      project: binding.project, principal_id: principal,
      session_instance_id: session, adapter_kind: 'claude-inbox',
    },
    // Being online does not mean an optional Channel is enabled or that the
    // model received a message. Existing principal fallback/hooks own intake.
    deliver: async () => { throw new Error('Use the durable inbox; Claude Channel is not enabled.'); },
    resilience: {
      start_router: () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../host-runtime/router.js', import.meta.url))], {
          detached: true, shell: false, stdio: 'ignore',
        });
        child.once('spawn', () => { child.unref(); resolve(); });
        child.once('error', reject);
      }),
    },
  });
}
