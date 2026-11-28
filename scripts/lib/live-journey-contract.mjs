export const LIVE_JOURNEY_SCHEMA_VERSION = 'memesh-live-journey/v5';
export const LIVE_JOURNEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LIVE_JOURNEY_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const CLAUDE_PLUGIN_ISOLATION_CONFIRMATION = 'MEMESH_PLUGIN_ISOLATION_CONFIRMED';
export const CLAUDE_MODEL_INTAKE_ARMING_CONFIRMATION = 'MEMESH_MODEL_INTAKE_ARMED';

export const CORE_JOURNEY_IDS = Object.freeze([
  'memory-round-trip',
  'session-start-briefing',
  'quiet-commit-capture',
  'stop-conversation',
  'packed-upgrade',
]);

export const CORE_JOURNEY_BOUNDARIES = Object.freeze({
  'memory-round-trip': 'isolated-process',
  'session-start-briefing': 'isolated-process',
  'quiet-commit-capture': 'isolated-process',
  'stop-conversation': 'isolated-process',
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
    source: 'claude_plugin_session_start',
    operator_attestation_recorded: true,
    trusted_instruction_attested: true,
  }),
});

/**
 * The required steps a report is missing, or has out of order, for a host. One
 * function for the runner (before it writes PASS) and for the release check, so
 * the two cannot disagree. A host with no required list (claude-inbox) yields null.
 *
 * @param {Array<{name?: string}>} steps
 * @param {string|null|undefined} host
 * @returns {string[]|null}
 */
export function missingRequiredSteps(steps, host) {
  const required = host ? REQUIRED_LIVE_JOURNEY_STEPS[host] : undefined;
  if (required === undefined) return null;
  let previousIndex = -1;
  const missing = [];
  for (const name of required) {
    const index = steps.findIndex((step, stepIndex) => stepIndex > previousIndex && step?.name === name);
    if (index === -1) missing.push(name);
    else previousIndex = index;
  }
  return missing;
}

export const REQUIRED_LIVE_JOURNEY_STEPS = Object.freeze({
  'conversation-pair': Object.freeze([
    'normal native trust and private sources confirmed',
    'two real host SessionStart registrations match native SID and PID',
    'native sender queued full body to known offline recipient',
    'recipient native read full body and replied to original sender',
    'original native sender read reply and quoted all three markers',
    'all owned native children terminal',
  ]),
  codex: Object.freeze([
    'Codex model-visible full body read and reply in the original native thread',
    'normal native trust and private sources confirmed',
    'two real host SessionStart registrations match native SID and PID',
    'all four kinds delivered both directions with full body and three markers',
    'idle recipient started its own turn without a driver prompt',
    'busy recipient read and replied in the same native session',
    'offline known recipient queued without delivery and received after resume',
    'unknown recipient rejected before storage',
    'native disconnect retained pending body without delivery',
    'all owned native children terminal',
  ]),
  claude: Object.freeze([
    'Claude model-visible full body read and reply in the original native session',
    'normal native trust and private sources confirmed',
    'two real host SessionStart registrations match native SID and PID',
    'all four kinds delivered both directions with full body and three markers',
    'idle recipient started its own turn without a driver prompt',
    'busy recipient read and replied in the same native session',
    'offline known recipient queued without delivery and received after resume',
    'unknown recipient rejected before storage',
    'native disconnect retained pending body without delivery',
    'all owned native children terminal',
  ]),
});
