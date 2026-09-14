export const LIVE_JOURNEY_SCHEMA_VERSION = 'memesh-live-journey/v4';
export const LIVE_JOURNEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LIVE_JOURNEY_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const CLAUDE_PLUGIN_ISOLATION_CONFIRMATION = 'MEMESH_PLUGIN_ISOLATION_CONFIRMED';
export const CLAUDE_MODEL_INTAKE_ARMING_CONFIRMATION = 'MEMESH_MODEL_INTAKE_ARMED';

export const CORE_JOURNEY_IDS = Object.freeze([
  'memory-round-trip',
  'session-start-briefing',
  'quiet-commit-capture',
  'stop-session-insight',
  'packed-upgrade',
]);

export const CORE_JOURNEY_BOUNDARIES = Object.freeze({
  'memory-round-trip': 'isolated-process',
  'session-start-briefing': 'isolated-process',
  'quiet-commit-capture': 'isolated-process',
  'stop-session-insight': 'isolated-process',
  'packed-upgrade': 'packed-consumer',
});

/**
 * Validate the common product journeys that every release receipt must carry.
 * Each row proves four different things: a successful path, a representative
 * failure, the persisted/user-visible result, and bounded cleanup.
 */
export function validateCoreJourneys(rows) {
  if (!Array.isArray(rows)) return { ok: false, reason: 'core_journeys are missing' };
  for (const id of CORE_JOURNEY_IDS) {
    const row = rows.find(candidate => candidate?.id === id);
    if (!row) return { ok: false, reason: `core journey ${id} is missing` };
    if (row.status !== 'PASS') return { ok: false, reason: `core journey ${id} is not PASS` };
    if (row.boundary !== CORE_JOURNEY_BOUNDARIES[id]) {
      return { ok: false, reason: `core journey ${id} has the wrong exercised boundary` };
    }
    for (const field of ['success', 'failure', 'effect_readback']) {
      if (!row[field] || typeof row[field] !== 'object' || row[field].observed !== true) {
        return { ok: false, reason: `core journey ${id} has no ${field} receipt` };
      }
    }
    if (!row.cleanup || typeof row.cleanup !== 'object' || row.cleanup.status !== 'PASS' || row.cleanup.removed !== true) {
      return { ok: false, reason: `core journey ${id} has no successful cleanup receipt` };
    }
  }
  return { ok: true, reason: null };
}

export const REQUIRED_REGISTRATION_EVIDENCE = Object.freeze({
  codex: Object.freeze({ source: 'codex_plugin_session_start', plugin_loader_verified: true }),
  claude: Object.freeze({
    source: 'interactive_development_channel',
    operator_attestation_recorded: true,
    trusted_instruction_attested: true,
  }),
});

export const REQUIRED_LIVE_JOURNEY_STEPS = Object.freeze({
  codex: Object.freeze([
    'codex preconditions',
    'router started against the temporary MEMESH_DIR',
    'real Codex thread created',
    'Codex thread registered with the router',
    'Codex plugin SessionStart hook registered the thread',
    'Codex lease renewed before expiry',
    'exact-session send accepted by the codex-cli-queue adapter',
    'Codex resume registration superseded the prior generation',
    'Codex resumed lease renewed before expiry',
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
    'operator attested that the trusted intake prompt was submitted and READY observed',
    'exact-session send accepted by the claude-channel adapter',
    'the Claude model called intake itself (model-visible proof)',
    'session disconnected and left the router directory',
    'a send to the stopped session fails closed and the durable row survives',
  ]),
});
