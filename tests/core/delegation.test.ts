import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import {
  DelegationInputError,
  recordDelegation,
  setDelegationVerdict,
  summarizeEnvelope,
} from '../../src/core/delegation.js';

const fixtureDir = path.join(__dirname, '..', 'fixtures', 'deepseek');
const harnessText = fs.readFileSync(path.join(fixtureDir, 'harness-envelope.json'), 'utf8');
const directText = fs.readFileSync(path.join(fixtureDir, 'direct-envelope.json'), 'utf8');
const promptSha = createHash('sha256').update('Summarise the auth module').digest('hex');

function stored(name: string) {
  const db = getDatabase();
  const row = db.prepare('SELECT id, type, metadata FROM entities WHERE name = ?').get(name) as
    { id: number; type: string; metadata: string } | undefined;
  if (!row) return null;
  const observations = (db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(row.id) as
    Array<{ content: string }>).map((o) => o.content);
  const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(row.id) as Array<{ tag: string }>).map((t) => t.tag);
  return { type: row.type, metadata: JSON.parse(row.metadata), observations, tags };
}

describe('summarizeEnvelope', () => {
  it('reads a Harness envelope', () => {
    expect(summarizeEnvelope(JSON.parse(harnessText))).toEqual({
      ok: true,
      mode: 'harness',
      model: 'deepseek-v4-flash',
      finishReason: 'completed',
      allowedTools: ['read_file', 'write_file'],
      usage: { prompt_tokens: 1834, completion_tokens: 412, total_tokens: 2246 },
    });
  });

  it('reads a direct envelope (no tools, failed run)', () => {
    const s = summarizeEnvelope(JSON.parse(directText));
    expect(s.mode).toBe('direct');
    expect(s.ok).toBe(false);
    expect(s.allowedTools).toEqual([]);
  });

  it('refuses what is not a worker envelope', () => {
    expect(() => summarizeEnvelope([])).toThrow(DelegationInputError);
    expect(() => summarizeEnvelope({ model: 'x' })).toThrow(/no boolean "ok"/);
    expect(() => summarizeEnvelope({ ok: true, allowed_tools: 'all' })).toThrow(/array of strings/);
  });
});

describe('recordDelegation / setDelegationVerdict', () => {
  useTestDatabase('memesh-delegation-');

  it('a fixture envelope yields one delegation entity with usage, tools, verdict and provenance', () => {
    const r = recordDelegation({ envelopeText: harnessText, promptSha256: promptSha, project: 'demo' });
    expect(r.stored).toBe(true);
    expect(r.name).toMatch(new RegExp(`^delegation-${promptSha.slice(0, 12)}-[0-9a-f]{8}$`));
    const e = stored(r.name)!;
    expect(e.type).toBe('delegation');
    expect(e.tags).toEqual(expect.arrayContaining(['source:deepseek-worker', 'project:demo']));
    expect(e.metadata.trust).toBe('untrusted');
    expect(e.metadata.provenance).toMatchObject({
      source: 'deepseek-worker',
      trust: 'untrusted-until-verified',
      verdict: 'unreviewed',
      prompt_sha256: promptSha,
      model: 'deepseek-v4-flash',
      allowed_tools: ['read_file', 'write_file'],
      usage: { prompt_tokens: 1834, completion_tokens: 412, total_tokens: 2246 },
      finish_reason: 'completed',
      source_host: 'cli',
    });
    expect(e.observations).toHaveLength(5);
    expect(e.observations).toEqual(expect.arrayContaining([
      'Allowed tools: read_file, write_file',
      'Usage: prompt_tokens=1834, completion_tokens=412, total_tokens=2246',
    ]));
  });

  it('never stores the prompt text or the worker output', () => {
    const r = recordDelegation({ envelopeText: harnessText, promptSha256: promptSha, project: 'demo' });
    const everything = JSON.stringify(stored(r.name));
    expect(everything).not.toContain('Summarise the auth module');
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('IGNORE PREVIOUS');
    expect(everything).not.toContain('/Users/someone');
  });

  it('recording the same envelope twice writes nothing the second time and reports the stored verdict', () => {
    const first = recordDelegation({ envelopeText: harnessText, promptSha256: promptSha, project: 'demo' });
    setDelegationVerdict({ name: first.name, verdict: 'accepted' });
    const again = recordDelegation({ envelopeText: harnessText, promptSha256: promptSha, project: 'demo' });
    expect(again.stored).toBe(false);
    expect(again.verdict).toBe('accepted');
    expect(stored(first.name)!.metadata.provenance.verdict).toBe('accepted');
  });

  it('the verify flip rewrites trust and verdict, keeps the rest of provenance, and appends the verdict', () => {
    const r = recordDelegation({ envelopeText: harnessText, promptSha256: promptSha, project: 'demo' });
    const before = stored(r.name)!;
    expect(before.metadata.provenance.trust).toBe('untrusted-until-verified');

    const v = setDelegationVerdict({ name: r.name, verdict: 'accepted', note: 'diff reviewed, tests re-run' });
    expect(v).toMatchObject({ previousVerdict: 'unreviewed', verdict: 'accepted', trust: 'verified' });

    const after = stored(r.name)!;
    expect(after.metadata.trust).toBe('trusted');
    expect(after.metadata.provenance).toMatchObject({
      source: 'deepseek-worker', trust: 'verified', verdict: 'accepted',
      prompt_sha256: promptSha, model: 'deepseek-v4-flash', source_host: 'cli',
    });
    expect(typeof after.metadata.provenance.verified_at).toBe('string');
    expect(after.observations.at(-1)).toMatch(/^Verdict: accepted by the orchestrator at .*Note: diff reviewed, tests re-run$/);

    setDelegationVerdict({ name: r.name, verdict: 'rejected' });
    const rejected = stored(r.name)!;
    expect(rejected.metadata.trust).toBe('untrusted');
    expect(rejected.metadata.provenance.trust).toBe('rejected');
  });

  it('verify refuses a name that is not a delegation record', () => {
    getDatabase().prepare("INSERT INTO entities (name, type) VALUES ('plain-note', 'note')").run();
    expect(() => setDelegationVerdict({ name: 'plain-note', verdict: 'accepted' })).toThrow(/not a delegation record/);
    expect(() => setDelegationVerdict({ name: 'missing', verdict: 'accepted' })).toThrow(/no memory named/);
  });

  it('refuses a malformed prompt hash and a non-JSON envelope', () => {
    expect(() => recordDelegation({ envelopeText: harnessText, promptSha256: 'abc', project: 'demo' })).toThrow(/sha256/);
    expect(() => recordDelegation({ envelopeText: 'not json', promptSha256: promptSha, project: 'demo' })).toThrow(/not JSON/);
  });
});
