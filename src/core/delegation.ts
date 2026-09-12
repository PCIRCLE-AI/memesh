// delegation — remember that a task was delegated to an untrusted worker,
// what was asked, what came back, and whether the orchestrator accepted it.
//
// The DeepSeek worker (the `deepseek-worker` skill: a two-node vLLM pool and
// a disposable Harness sandbox) is a delegate, not a host. It has no MCP
// tools, its only network peer is a task-specific gateway, and the machine's
// `memesh serve` is loopback-only — so it cannot write the graph, and it must
// not: its output is untrusted by policy. What memesh CAN remember is the
// delegation itself, written by the ORCHESTRATOR from the JSON envelope the
// worker client printed:
//
//   - the prompt's sha256, never the prompt text;
//   - model, mode, allowed_tools, usage, finish_reason, ok;
//   - the orchestrator's verdict, and `trust: untrusted-until-verified` until
//     it gives one.
//
// The worker's output (`content`, `parsed`, `final_response`, diagnostics)
// is deliberately NOT stored: it is untrusted text, and a verified conclusion
// belongs in a memory the orchestrator writes in its own words, with this
// entity as the cause.
//
// There is no HTTP route or MCP tool for this — the only door is the local
// `memesh delegation` CLI, run by the orchestrator on the orchestrator's
// machine. Nothing the sandbox can reach writes here.

import { createHash } from 'crypto';
import { getDatabase } from '../db.js';
import { remember } from './operations.js';
import { redactSecrets } from './paths.js';

export const DELEGATION_TYPE = 'delegation';
export const DELEGATION_SOURCE = 'deepseek-worker';
export const DELEGATION_VERDICTS = ['unreviewed', 'accepted', 'rejected'] as const;
export type DelegationVerdict = typeof DELEGATION_VERDICTS[number];
export type DelegationTrust = 'untrusted-until-verified' | 'verified' | 'rejected';

/** Envelopes are small JSON objects; anything bigger is not one. */
export const ENVELOPE_MAX_BYTES = 4 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const;

export class DelegationInputError extends Error {}

export interface EnvelopeSummary {
  ok: boolean;
  mode: 'direct' | 'harness';
  model: string | null;
  finishReason: string | null;
  /** null when the envelope does not report them — not the same as none. */
  allowedTools: string[] | null;
  usage: Partial<Record<typeof USAGE_KEYS[number], number>>;
}

/** Envelope strings are worker-controlled: strip controls, cap, redact. */
function clean(value: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  return redactSecrets(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')).slice(0, max);
}

/**
 * Read only the fields a delegation record needs, and refuse anything that
 * is not a worker envelope. `ok` is the one field every envelope carries —
 * direct, Harness, error or refusal — so its absence means "not an envelope".
 */
export function summarizeEnvelope(raw: unknown): EnvelopeSummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DelegationInputError('the envelope must be a JSON object');
  }
  const env = raw as Record<string, unknown>;
  if (typeof env.ok !== 'boolean') {
    throw new DelegationInputError('the envelope has no boolean "ok" — this is not a worker envelope');
  }
  let allowedTools: string[] | null = null;
  if (env.allowed_tools !== undefined) {
    if (!Array.isArray(env.allowed_tools) || !env.allowed_tools.every((t) => typeof t === 'string')) {
      throw new DelegationInputError('"allowed_tools" must be an array of strings');
    }
    allowedTools = (env.allowed_tools as string[]).map((t) => clean(t, 64)).slice(0, 50);
  }
  const usage: EnvelopeSummary['usage'] = {};
  if (env.usage && typeof env.usage === 'object' && !Array.isArray(env.usage)) {
    for (const key of USAGE_KEYS) {
      const v = (env.usage as Record<string, unknown>)[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) usage[key] = Math.floor(v);
    }
  }
  return {
    ok: env.ok,
    // Only the Harness client adds `task_id`; direct mode never has one.
    mode: typeof env.task_id === 'string' ? 'harness' : 'direct',
    model: typeof env.model === 'string' && env.model ? clean(env.model) : null,
    finishReason: typeof env.finish_reason === 'string' && env.finish_reason ? clean(env.finish_reason, 40) : null,
    allowedTools,
    usage,
  };
}

/** `metadata.provenance` of a stored row; `{}` when absent or unparseable. */
function storedProvenance(metadata: string | null): Record<string, unknown> {
  try {
    const parsed = metadata ? JSON.parse(metadata) as { provenance?: unknown } : {};
    return parsed.provenance && typeof parsed.provenance === 'object' ? parsed.provenance as Record<string, unknown> : {};
  } catch {
    // Unparseable metadata: treated as "no provenance", which makes
    // setDelegationVerdict refuse the row rather than guess.
    return {};
  }
}

function trustFor(verdict: DelegationVerdict): DelegationTrust {
  switch (verdict) {
    case 'accepted': return 'verified';
    case 'rejected': return 'rejected';
    default: return 'untrusted-until-verified';
  }
}

function verdictLine(verdict: DelegationVerdict, at: string, note?: string): string {
  const base = verdict === 'unreviewed'
    ? 'Verdict: unreviewed — the worker output is untrusted until the orchestrator verifies it'
    : `Verdict: ${verdict} by the orchestrator at ${at}`;
  return note ? `${base}. Note: ${clean(note, 500)}` : base;
}

export interface RecordDelegationInput {
  /** The envelope file's exact bytes, as the worker client printed them. */
  envelopeText: string;
  /** sha256 (hex) of the prompt sent to the worker. */
  promptSha256: string;
  verdict?: DelegationVerdict;
  /** What the orchestrator decided to do next, in its own words. */
  followUp?: string;
  /**
   * The tools the orchestrator granted, in its own words. The worker's
   * envelope is untrusted and only the Harness client reports the list, so
   * the orchestrator's statement wins; a disagreement is recorded.
   */
  grantedTools?: string[];
  /** Project tag; the CLI passes the orchestrator's current project. */
  project: string;
}

export interface RecordDelegationResult {
  /** false when this exact envelope was already recorded — nothing was written. */
  stored: boolean;
  name: string;
  verdict: DelegationVerdict;
  trust: DelegationTrust;
  summary: EnvelopeSummary;
}

/** Store one delegation entity. Recording the same envelope twice is a no-op. */
export function recordDelegation(input: RecordDelegationInput): RecordDelegationResult {
  if (!SHA256_RE.test(input.promptSha256)) {
    throw new DelegationInputError('the prompt hash must be 64 lowercase hex characters (sha256)');
  }
  if (Buffer.byteLength(input.envelopeText, 'utf8') > ENVELOPE_MAX_BYTES) {
    throw new DelegationInputError(`the envelope is larger than ${ENVELOPE_MAX_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.envelopeText);
  } catch (err) {
    throw new DelegationInputError(`the envelope is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = summarizeEnvelope(parsed);
  const verdict = input.verdict ?? 'unreviewed';
  const trust = trustFor(verdict);
  const envelopeSha256 = createHash('sha256').update(input.envelopeText).digest('hex');
  const name = `delegation-${input.promptSha256.slice(0, 12)}-${envelopeSha256.slice(0, 8)}`;

  const existing = getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(name) as
    { metadata: string | null } | undefined;
  if (existing) {
    // Report what is STORED, not what this call asked for: a re-record must
    // not read as though it had reset an accepted delegation to unreviewed.
    const stored = storedProvenance(existing.metadata);
    const storedVerdict = (DELEGATION_VERDICTS as readonly unknown[]).includes(stored.verdict)
      ? stored.verdict as DelegationVerdict : 'unreviewed';
    return { stored: false, name, verdict: storedVerdict, trust: trustFor(storedVerdict), summary };
  }

  const granted = input.grantedTools?.map((t) => clean(t, 64)).slice(0, 50);
  const allowedTools = granted ?? summary.allowedTools;
  let allowedSource: 'orchestrator' | 'envelope' | null = null;
  if (granted) allowedSource = 'orchestrator';
  else if (summary.allowedTools) allowedSource = 'envelope';
  const toolsLine = allowedTools === null
    ? 'Allowed tools: not reported in the envelope'
    : `Allowed tools: ${allowedTools.length ? allowedTools.join(', ') : 'none'}${granted ? ' (granted by the orchestrator)' : ''}`;
  const envelopeDisagrees = granted && summary.allowedTools
    && [...granted].sort().join('\0') !== [...summary.allowedTools].sort().join('\0');

  const at = new Date().toISOString();
  const usageText = USAGE_KEYS.filter((k) => summary.usage[k] !== undefined)
    .map((k) => `${k}=${summary.usage[k]}`).join(', ');
  remember({
    name,
    type: DELEGATION_TYPE,
    title: `${at.slice(0, 10)} delegation to ${summary.model ?? 'worker'} (${summary.mode})`,
    observations: [
      `Delegated to ${summary.model ?? 'an unnamed model'} (${summary.mode} mode); prompt sha256 ${input.promptSha256}`,
      toolsLine,
      ...(envelopeDisagrees
        ? [`Allowed tools mismatch: the envelope reports ${summary.allowedTools!.join(', ') || 'none'}`] : []),
      `Result: ok=${summary.ok}, finish_reason=${summary.finishReason ?? 'none'}`,
      usageText ? `Usage: ${usageText}` : 'Usage: not reported in the envelope',
      verdictLine(verdict, at),
      ...(input.followUp ? [`Follow-up: ${clean(input.followUp, 500)}`] : []),
    ],
    tags: [`source:${DELEGATION_SOURCE}`, `project:${input.project}`],
    trustOverride: verdict === 'accepted' ? 'trusted' : 'untrusted',
    provenanceOverride: {
      source: DELEGATION_SOURCE,
      trust,
      verdict,
      ...(verdict !== 'unreviewed' ? { verified_at: at } : {}),
      prompt_sha256: input.promptSha256,
      envelope_sha256: envelopeSha256,
      model: summary.model,
      mode: summary.mode,
      allowed_tools: allowedTools,
      allowed_tools_source: allowedSource,
      ...(granted && summary.allowedTools ? { envelope_allowed_tools: summary.allowedTools } : {}),
      usage: summary.usage,
      finish_reason: summary.finishReason,
      ok: summary.ok,
    },
    sourceHost: 'cli',
  });
  return { stored: true, name, verdict, trust, summary };
}

export interface SetVerdictResult {
  name: string;
  previousVerdict: string | null;
  verdict: Exclude<DelegationVerdict, 'unreviewed'>;
  trust: DelegationTrust;
}

/**
 * The verify flip: the orchestrator checked the worker's result and accepts
 * or rejects it. Rewrites the verdict/trust in provenance (every other
 * provenance field is kept) and appends the verdict as an observation, so
 * the history reads in order.
 */
export function setDelegationVerdict(input: {
  name: string;
  verdict: Exclude<DelegationVerdict, 'unreviewed'>;
  note?: string;
}): SetVerdictResult {
  const row = getDatabase()
    .prepare('SELECT type, metadata FROM entities WHERE name = ?')
    .get(input.name) as { type: string; metadata: string | null } | undefined;
  if (!row) throw new DelegationInputError(`no memory named "${input.name}"`);
  const provenance = storedProvenance(row.metadata);
  if (row.type !== DELEGATION_TYPE || provenance.source !== DELEGATION_SOURCE) {
    throw new DelegationInputError(`"${input.name}" is not a delegation record`);
  }
  const at = new Date().toISOString();
  const trust = trustFor(input.verdict);
  remember({
    name: input.name,
    type: DELEGATION_TYPE,
    observations: [verdictLine(input.verdict, at, input.note)],
    trustOverride: input.verdict === 'accepted' ? 'trusted' : 'untrusted',
    provenanceOverride: { ...provenance, trust, verdict: input.verdict, verified_at: at },
    sourceHost: 'cli',
  });
  return {
    name: input.name,
    previousVerdict: typeof provenance.verdict === 'string' ? provenance.verdict : null,
    verdict: input.verdict,
    trust,
  };
}
