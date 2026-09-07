export const LIVE_JOURNEY_SCHEMA_VERSION = 'memesh-live-journey/v2';
export const LIVE_JOURNEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LIVE_JOURNEY_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const CLAUDE_PLUGIN_ISOLATION_CONFIRMATION = 'MEMESH_PLUGIN_ISOLATION_CONFIRMED';

export const REQUIRED_REGISTRATION_EVIDENCE = Object.freeze({
  codex: Object.freeze({ source: 'codex_plugin_session_start', plugin_loader_verified: true }),
  claude: Object.freeze({ source: 'interactive_development_channel', operator_attestation_recorded: true }),
});

export const REQUIRED_LIVE_JOURNEY_STEPS = Object.freeze({
  codex: Object.freeze([
    'codex preconditions',
    'router started against the temporary MEMESH_DIR',
    'real Codex thread created',
    'Codex thread registered with the router',
    'Codex plugin SessionStart hook registered the thread',
    'Codex lease renewed before expiry',
    'Codex resume registration superseded the prior generation',
    'exact-session send accepted by the codex-cli-queue adapter',
    'the Codex model quoted the envelope back (model-visible proof)',
    'companion stopped and the session left the router directory',
    'a send to the stopped session fails closed and the durable row survives',
  ]),
  claude: Object.freeze([
    'claude precondition',
    'router started against the temporary MEMESH_DIR',
    'agent setup claude',
    'interactive Claude session registered on the channel',
    'Claude lease renewed before expiry',
    'operator attested that no installed MeMesh plugin hook or MCP server was present',
    'exact-session send accepted by the claude-channel adapter',
    'the Claude model called intake itself (model-visible proof)',
    'session disconnected and left the router directory',
    'a send to the stopped session fails closed and the durable row survives',
  ]),
});
