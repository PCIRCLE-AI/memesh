/**
 * The environment variables `detectHookHost` (src/core/capture-liveness.ts)
 * reads to decide which agent host a hook run is under. A spawned hook
 * inherits the test runner's environment, so without this a suite run from
 * inside Claude Code (CLAUDECODE=1) or Codex (CODEX_HOME) would decide the
 * host for the test — green on one machine, red on CI. A test that needs a
 * host sets it explicitly after this.
 */
const HOST_IDENTITY_VARS = [
  'MEMESH_HOOK_HOST',
  'CODEX_HOME',
  'CODEX_SANDBOX',
  'CODEX_PLUGIN_ROOT',
  'PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDECODE',
] as const;

export function withoutHostIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of HOST_IDENTITY_VARS) delete copy[name];
  return copy;
}
