// #251 — the token-usage probe and the benchmark contract validator.
//
// The probe is tested against SYNTHETIC transcripts written here, shaped like
// the records the two hosts write (see benchmarks/token/usage-probe.mjs for
// the field inventory that was read off real transcripts). No real transcript
// is committed: a real one carries prompt text.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as probe from '../../benchmarks/token/usage-probe.mjs';
import * as validator from '../../benchmarks/token/validate.mjs';

// Plain ESM evidence tooling: its JSDoc types are looser than what the
// assertions below need, so the tests read the results as loose objects.
type Probe = (file: string, opts?: { arm?: string }) => { measurable: boolean; reason?: string; ledger?: any };
const probeTranscript = probe.probeTranscript as unknown as Probe;
const validateContract = validator.validateContract as unknown as (c: any, k: any) => string[];
const validateRunManifest = validator.validateRunManifest as unknown as (m: any, c: any, k: any, o?: { official?: boolean }) => string[];
const corpusDigest = validator.corpusDigest as unknown as (k: any) => string;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'benchmarks/token/contract.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(repoRoot, 'benchmarks/token/cases.json'), 'utf8'));

const tmpDirs: string[] = [];
function tmpFile(name: string, lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-token-probe-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const claudeRecord = (requestId: string, block: Record<string, unknown>, usage: Record<string, number>) => ({
  type: 'assistant', requestId, uuid: `${requestId}-${block.type}`, timestamp: '2026-09-10T11:00:00.000Z',
  message: { model: 'claude-haiku-4-5-20251001', content: [block], usage },
});

describe('usage-probe: Claude Code transcripts', () => {
  it('takes usage once per request, collects tool_use names across the split records, and sums context tokens', () => {
    const u1 = { input_tokens: 10, cache_read_input_tokens: 17622, cache_creation_input_tokens: 3271, output_tokens: 151 };
    const u2 = { input_tokens: 10, cache_read_input_tokens: 20893, cache_creation_input_tokens: 536, output_tokens: 93 };
    const file = tmpFile('session.jsonl', [
      { type: 'user', message: { role: 'user', content: 'prompt text must never reach the ledger' } },
      claudeRecord('req_1', { type: 'thinking', thinking: '…' }, u1),
      claudeRecord('req_1', { type: 'tool_use', name: 'ToolSearch', input: {} }, u1),
      claudeRecord('req_2', { type: 'tool_use', name: 'mcp__memesh__recall', input: {} }, u2),
      claudeRecord('req_2', { type: 'text', text: 'OK' }, u2),
      '{"type":"assistant","truncated', // a partial trailing line is ignored, not fatal
    ]);
    const result = probeTranscript(file, { arm: 'tool-result' });
    expect(result.measurable).toBe(true);
    const { ledger } = result;
    expect(ledger.host).toBe('claude-code');
    expect(ledger.models).toEqual(['claude-haiku-4-5-20251001']);
    expect(ledger.turns).toHaveLength(2);
    expect(ledger.turns[0].tool_uses).toEqual(['ToolSearch']);
    expect(ledger.turns[1].tool_uses).toEqual(['mcp__memesh__recall']);
    expect(ledger.totals).toMatchObject({ requests: 2, input_tokens: 20, cache_read_input_tokens: 38515, cache_creation_input_tokens: 3807, output_tokens: 244, tool_calls: 2 });
    expect(ledger.totals.context_tokens).toBe(10 + 17622 + 3271 + 10 + 20893 + 536);
    expect(ledger.session.transcript_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ledger)).not.toContain('prompt text');
  });

  it('is UNMEASURABLE when a usage field is missing, when there is no model, and when the shape is unknown', () => {
    const noCache = tmpFile('a.jsonl', [claudeRecord('r', { type: 'text', text: 'x' }, { input_tokens: 5, output_tokens: 1 } as never)]);
    expect(probeTranscript(noCache)).toMatchObject({ measurable: false, reason: expect.stringContaining('cache_read_input_tokens') });
    const noModel = tmpFile('b.jsonl', [{ ...claudeRecord('r', { type: 'text', text: 'x' }, { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }), message: { content: [], usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }]);
    expect(probeTranscript(noModel)).toMatchObject({ measurable: false, reason: expect.stringContaining('model') });
    const unknown = tmpFile('c.jsonl', [{ hello: 'world' }]);
    expect(probeTranscript(unknown)).toMatchObject({ measurable: false, reason: expect.stringContaining('not recognised') });
    expect(probeTranscript(path.join(os.tmpdir(), 'does-not-exist.jsonl'))).toMatchObject({ measurable: false, reason: expect.stringContaining('ENOENT') });
  });
});

describe('usage-probe: Codex rollouts', () => {
  it('reads last_token_usage per token_count event, keeps the inclusive input convention, and attributes function_call names', () => {
    const file = tmpFile('rollout.jsonl', [
      { timestamp: 't0', type: 'session_meta', payload: { id: 's' } },
      { timestamp: 't1', type: 'turn_context', payload: { model: 'gpt-5.6-luna' } },
      { timestamp: 't2', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
      { timestamp: 't3', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 29650, cached_input_tokens: 9984, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } } } },
      { timestamp: 't4', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 30000, cached_input_tokens: 29000, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 2 } } } },
    ]);
    const result = probeTranscript(file, { arm: 'control' });
    expect(result.measurable).toBe(true);
    expect(result.ledger.host).toBe('codex');
    expect(result.ledger.models).toEqual(['gpt-5.6-luna']);
    expect(result.ledger.turns.map((t: { tool_uses: string[] }) => t.tool_uses)).toEqual([['shell'], []]);
    // Codex input_tokens already includes cached tokens: context is not double counted.
    expect(result.ledger.totals.context_tokens).toBe(29650 + 30000);
    expect(result.ledger.totals.tool_calls).toBe(1);
  });
});

describe('usage-probe CLI', () => {
  it('exits 1 and says UNMEASURABLE instead of printing a guessed number', () => {
    const file = tmpFile('empty.jsonl', [{ type: 'user', message: {} }]);
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'benchmarks/token/usage-probe.mjs'), file], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('UNMEASURABLE');
    expect(r.stdout).toBe('');
  });
});

describe('benchmark contract validator', () => {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  it('accepts the committed contract and cases, and the npm script exits 0', () => {
    expect(validateContract(contract, cases)).toEqual([]);
    const out = execFileSync(process.execPath, [path.join(repoRoot, 'benchmarks/token/validate.mjs')], { encoding: 'utf8' });
    expect(out).toContain('8 cases cover 8 categories');
  });

  it.each([
    ['a required category with no case', (c: any, k: any) => { k.cases = k.cases.filter((x: any) => x.category !== 'conflict'); }, 'no case covers required category conflict'],
    ['no negative stale-answer case', (c: any, k: any) => { for (const x of k.cases) delete x.negative; }, 'no negative case rejects'],
    ['per-arm ground truth', (c: any, k: any) => { k.cases[0].treatment_ground_truth = { memories: [] }; }, 'per-arm ground truth is forbidden'],
    ['a case without ground truth', (c: any, k: any) => { k.cases[1].ground_truth = { memories: [] }; }, 'ground_truth.memories must be a non-empty array'],
    ['abstention fields that disagree', (c: any, k: any) => { k.cases[2].correct_abstention = false; }, 'disagree'],
    ['an unknown failure class', (c: any, k: any) => { k.cases[0].failure_class_if_wrong = 'meh'; }, 'not a contract failure class'],
    ['a secret in the corpus', (c: any, k: any) => { k.cases[0].ground_truth.memories[0].observations.push('token sk-abcdefghijklmnop'); }, 'looks like a secret'],
    ['frozen statistics without numbers', (c: any) => { c.statistics.status = 'frozen'; }, 'frozen statistics need a positive sample_size'],
    ['a host that does not say whether tool definitions are itemised', (c: any) => { delete c.measurability.hosts[0].tool_definitions_itemised; }, 'tool_definitions_itemised must be stated'],
  ])('rejects %s', (_name, mutate, expected) => {
    const c = clone(contract); const k = clone(cases);
    mutate(c, k);
    expect(validateContract(c, k).join('\n')).toContain(expected);
  });

  const ledger = (host: string, model: string) => ({
    schema: 'memesh-token-usage-ledger/1', host, models: [model],
    session: { transcript_sha256: 'a'.repeat(64) }, turns: [{ input_tokens: 1 }],
  });
  const manifest = () => ({
    mode: 'pilot',
    source_sha: 'b'.repeat(40), artifact_digest: 'c'.repeat(64), corpus_digest: corpusDigest(cases),
    host: 'claude-code', model: 'claude-haiku-4-5-20251001',
    usage_provenance: { control: ledger('claude-code', 'claude-haiku-4-5-20251001'), treatment: ledger('claude-code', 'claude-haiku-4-5-20251001') },
  });

  it('accepts a fully bound pilot manifest', () => {
    expect(validateRunManifest(manifest(), contract, cases)).toEqual([]);
  });

  it.each([
    ['source_sha', (m: any) => { delete m.source_sha; }, 'missing source_sha'],
    ['artifact_digest', (m: any) => { delete m.artifact_digest; }, 'missing artifact_digest'],
    ['corpus_digest', (m: any) => { delete m.corpus_digest; }, 'missing corpus_digest'],
    ['host', (m: any) => { delete m.host; }, 'missing host'],
    ['model', (m: any) => { delete m.model; }, 'missing model'],
    ['usage_provenance', (m: any) => { delete m.usage_provenance; }, 'missing usage_provenance'],
    ['a corpus digest that does not match cases.json', (m: any) => { m.corpus_digest = 'd'.repeat(64); }, 'does not match cases.json'],
    ['a treatment ledger', (m: any) => { delete m.usage_provenance.treatment; }, 'usage_provenance.treatment missing'],
    ['a ledger from another model', (m: any) => { m.usage_provenance.control.models = ['gpt-5.6-luna']; }, 'do not include manifest model'],
    ['estimated tokens presented as a result', (m: any) => { m.estimated_tokens = 1234; }, 'diagnostics and may not appear'],
  ])('refuses a manifest missing or contradicting %s', (_name, mutate, expected) => {
    const m = manifest(); mutate(m);
    expect(validateRunManifest(m, contract, cases).join('\n')).toContain(expected);
  });

  it('refuses an official run while the statistics are still pilot', () => {
    const m = { ...manifest(), mode: 'official' };
    expect(validateRunManifest(m, contract, cases, { official: true }).join('\n')).toContain('not frozen');
    const frozen = clone(contract);
    Object.assign(frozen.statistics, { status: 'frozen', sample_size: 40, repeats_per_case: 3, minimum_meaningful_effect: 0.1 });
    expect(validateRunManifest(m, frozen, cases, { official: true })).toEqual([]);
  });
});
