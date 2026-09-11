import { createHash } from 'crypto';
import { getDatabase } from '../db.js';
import { remember } from './operations.js';
import { redactSecrets } from './paths.js';
export const DELEGATION_TYPE = 'delegation';
export const DELEGATION_SOURCE = 'deepseek-worker';
export const DELEGATION_VERDICTS = ['unreviewed', 'accepted', 'rejected'];
export const ENVELOPE_MAX_BYTES = 4 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
export class DelegationInputError extends Error {
}
function clean(value, max = 120) {
    return redactSecrets(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')).slice(0, max);
}
export function summarizeEnvelope(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new DelegationInputError('the envelope must be a JSON object');
    }
    const env = raw;
    if (typeof env.ok !== 'boolean') {
        throw new DelegationInputError('the envelope has no boolean "ok" — this is not a worker envelope');
    }
    let allowedTools = null;
    if (env.allowed_tools !== undefined) {
        if (!Array.isArray(env.allowed_tools) || !env.allowed_tools.every((t) => typeof t === 'string')) {
            throw new DelegationInputError('"allowed_tools" must be an array of strings');
        }
        allowedTools = env.allowed_tools.map((t) => clean(t, 64)).slice(0, 50);
    }
    const usage = {};
    if (env.usage && typeof env.usage === 'object' && !Array.isArray(env.usage)) {
        for (const key of USAGE_KEYS) {
            const v = env.usage[key];
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
                usage[key] = Math.floor(v);
        }
    }
    return {
        ok: env.ok,
        mode: typeof env.task_id === 'string' ? 'harness' : 'direct',
        model: typeof env.model === 'string' && env.model ? clean(env.model) : null,
        finishReason: typeof env.finish_reason === 'string' && env.finish_reason ? clean(env.finish_reason, 40) : null,
        allowedTools,
        usage,
    };
}
function storedProvenance(metadata) {
    try {
        const parsed = metadata ? JSON.parse(metadata) : {};
        return parsed.provenance && typeof parsed.provenance === 'object' ? parsed.provenance : {};
    }
    catch {
        return {};
    }
}
function trustFor(verdict) {
    return verdict === 'accepted' ? 'verified' : verdict === 'rejected' ? 'rejected' : 'untrusted-until-verified';
}
function verdictLine(verdict, at, note) {
    const base = verdict === 'unreviewed'
        ? 'Verdict: unreviewed — the worker output is untrusted until the orchestrator verifies it'
        : `Verdict: ${verdict} by the orchestrator at ${at}`;
    return note ? `${base}. Note: ${clean(note, 500)}` : base;
}
export function recordDelegation(input) {
    if (!SHA256_RE.test(input.promptSha256)) {
        throw new DelegationInputError('the prompt hash must be 64 lowercase hex characters (sha256)');
    }
    if (Buffer.byteLength(input.envelopeText, 'utf8') > ENVELOPE_MAX_BYTES) {
        throw new DelegationInputError(`the envelope is larger than ${ENVELOPE_MAX_BYTES} bytes`);
    }
    let parsed;
    try {
        parsed = JSON.parse(input.envelopeText);
    }
    catch (err) {
        throw new DelegationInputError(`the envelope is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const summary = summarizeEnvelope(parsed);
    const verdict = input.verdict ?? 'unreviewed';
    const trust = trustFor(verdict);
    const envelopeSha256 = createHash('sha256').update(input.envelopeText).digest('hex');
    const name = `delegation-${input.promptSha256.slice(0, 12)}-${envelopeSha256.slice(0, 8)}`;
    const existing = getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(name);
    if (existing) {
        const stored = storedProvenance(existing.metadata);
        const storedVerdict = DELEGATION_VERDICTS.includes(stored.verdict)
            ? stored.verdict : 'unreviewed';
        return { stored: false, name, verdict: storedVerdict, trust: trustFor(storedVerdict), summary };
    }
    const granted = input.grantedTools?.map((t) => clean(t, 64)).slice(0, 50);
    const allowedTools = granted ?? summary.allowedTools;
    const allowedSource = granted ? 'orchestrator' : summary.allowedTools ? 'envelope' : null;
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
                ? [`Allowed tools mismatch: the envelope reports ${summary.allowedTools.join(', ') || 'none'}`] : []),
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
export function setDelegationVerdict(input) {
    const row = getDatabase()
        .prepare('SELECT type, metadata FROM entities WHERE name = ?')
        .get(input.name);
    if (!row)
        throw new DelegationInputError(`no memory named "${input.name}"`);
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
//# sourceMappingURL=delegation.js.map