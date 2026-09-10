#!/usr/bin/env node
// Token-benchmark contract validator (#251).
//
// Two things are checked, and the second only if a run manifest is given:
//
//   1. The frozen contract (contract.json) and the case corpus (cases.json)
//      are internally complete: every required category has a case, every
//      case defines the same ground truth for both arms, an expected answer,
//      whether abstaining is correct, and a failure class; at least one case
//      is a negative that rejects a plausible but stale answer.
//
//   2. A run manifest (`--run <manifest.json>`) binds a result to what
//      produced it: source SHA, artifact digest, corpus digest, host and
//      model identity, and usage provenance (one ledger per arm, produced by
//      usage-probe.mjs). Missing any of these → exit 1. `--official` also
//      requires contract.statistics.status === 'frozen' and the frozen numbers.
//
// Usage:
//   node benchmarks/token/validate.mjs                       # contract + cases
//   node benchmarks/token/validate.mjs --run <manifest.json> [--official]
//
// Exit 0 = valid; 1 = one or more failures (each printed); 2 = usage error.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function corpusDigest(casesJson) {
  return createHash('sha256').update(JSON.stringify(casesJson.cases)).digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // A usage error, reported as one: no stack trace, no absolute path echo.
    console.error(`cannot read ${path.basename(file)}: ${err.code || 'not valid JSON'}`);
    process.exit(2);
  }
}

/** @returns {string[]} failures (empty = valid) */
export function validateContract(contract, cases) {
  const failures = [];
  if (contract.schema !== 'memesh-token-benchmark-contract/1') failures.push('contract.schema is not memesh-token-benchmark-contract/1');
  if (!['MEASURABLE', 'UNMEASURABLE'].includes(contract.measurability?.verdict)) failures.push('contract.measurability.verdict must be MEASURABLE or UNMEASURABLE');
  if (contract.measurability?.verdict === 'MEASURABLE' && !(contract.measurability.hosts?.length > 0)) failures.push('MEASURABLE verdict without a host that provided usage');
  for (const host of contract.measurability?.hosts ?? []) {
    for (const f of ['host', 'usage_source', 'fields', 'session_boundary', 'caching', 'arm_attribution']) {
      if (host[f] === undefined) failures.push(`host ${host.host ?? '?'}: missing ${f}`);
    }
    if (host.tool_definitions_itemised === undefined) failures.push(`host ${host.host ?? '?'}: tool_definitions_itemised must be stated (true/false)`);
  }
  const categories = contract.required_case_categories ?? [];
  if (categories.length === 0) failures.push('contract.required_case_categories is empty');
  const stats = contract.statistics ?? {};
  if (!['pilot', 'frozen'].includes(stats.status)) failures.push('contract.statistics.status must be pilot or frozen');
  if (stats.confidence_interval !== 0.95) failures.push('contract.statistics.confidence_interval must be 0.95');
  if (!stats.paired_analysis) failures.push('contract.statistics.paired_analysis must be stated');
  if (stats.status === 'frozen') {
    for (const f of ['sample_size', 'repeats_per_case', 'minimum_meaningful_effect']) {
      if (typeof stats[f] !== 'number' || !(stats[f] > 0)) failures.push(`frozen statistics need a positive ${f}`);
    }
  }

  if (cases.schema !== 'memesh-token-benchmark-cases/1') failures.push('cases.schema is not memesh-token-benchmark-cases/1');
  const list = cases.cases ?? [];
  const seenIds = new Set();
  const covered = new Set();
  let negatives = 0;
  for (const c of list) {
    const id = c.id ?? '(no id)';
    if (seenIds.has(id)) failures.push(`duplicate case id ${id}`);
    seenIds.add(id);
    if (!categories.includes(c.category)) failures.push(`${id}: category ${c.category} is not in the contract`);
    covered.add(c.category);
    if (!Array.isArray(c.ground_truth?.memories) || c.ground_truth.memories.length === 0) failures.push(`${id}: ground_truth.memories must be a non-empty array shared by both arms`);
    if (c.control_ground_truth || c.treatment_ground_truth) failures.push(`${id}: per-arm ground truth is forbidden — both arms see the same corpus`);
    if (typeof c.task_prompt !== 'string' || !c.task_prompt) failures.push(`${id}: task_prompt missing`);
    if (!c.expected_answer || typeof c.expected_answer.abstain !== 'boolean' || !Array.isArray(c.expected_answer.must_contain)) failures.push(`${id}: expected_answer needs must_contain[] and abstain`);
    if (typeof c.correct_abstention !== 'boolean') failures.push(`${id}: correct_abstention must be stated`);
    if (c.expected_answer && typeof c.correct_abstention === 'boolean' && c.expected_answer.abstain !== c.correct_abstention) failures.push(`${id}: expected_answer.abstain and correct_abstention disagree`);
    if (!(contract.scoring?.failure_classes ?? []).includes(c.failure_class_if_wrong)) failures.push(`${id}: failure_class_if_wrong ${c.failure_class_if_wrong} is not a contract failure class`);
    if (!Array.isArray(c.allowed_tools) || c.allowed_tools.length === 0) failures.push(`${id}: allowed_tools missing`);
    if (typeof c.time_limit_s !== 'number') failures.push(`${id}: time_limit_s missing`);
    if (c.negative === true) {
      negatives++;
      const stale = c.expected_answer?.must_not_contain ?? [];
      if (stale.length === 0) failures.push(`${id}: a negative case must say what a stale answer would contain (must_not_contain)`);
      if (c.failure_class_if_wrong !== 'stale-answer-accepted') failures.push(`${id}: a negative case fails as stale-answer-accepted`);
      // The plausible-but-wrong answer must actually BE in the corpus, or the
      // case tests nothing. This is a presence check, deliberately LOOSER than
      // the scorer's answer_matching rule in contract.json (plain
      // case-insensitive substring over names and observations).
      const corpus = (c.ground_truth?.memories ?? []).flatMap(m => [m.name ?? '', ...(m.observations ?? [])]).join('\n').toLowerCase();
      for (const phrase of stale) {
        if (!corpus.includes(String(phrase).toLowerCase())) failures.push(`${id}: negative case's stale phrase "${phrase}" is not present in ground_truth.memories`);
      }
    }
    // Everything a runner will put in front of a model is scanned, not only
    // the memories: a prompt or an expected answer can leak a path too.
    const scanned = JSON.stringify({ g: c.ground_truth, p: c.task_prompt, e: c.expected_answer });
    if (/sk-[A-Za-z0-9]{8,}|BEGIN (RSA|OPENSSH) PRIVATE KEY|\/Users\/[a-z]|\/home\/[a-z]/.test(scanned)) failures.push(`${id}: case contains what looks like a secret or a real user path`);
  }
  for (const cat of categories) if (!covered.has(cat)) failures.push(`no case covers required category ${cat}`);
  if (negatives === 0) failures.push('no negative case rejects a plausible but stale/unsupported answer');
  return failures;
}

/** @returns {string[]} failures */
export function validateRunManifest(manifest, contract, cases, { official = false } = {}) {
  const failures = [];
  for (const f of contract.run_manifest_required ?? []) {
    if (manifest[f] === undefined || manifest[f] === null || manifest[f] === '') failures.push(`run manifest: missing ${f}`);
  }
  if (manifest.source_sha && !/^[0-9a-f]{40}$/.test(manifest.source_sha)) failures.push('run manifest: source_sha must be a full 40-hex commit SHA');
  if (manifest.artifact_digest && !/^sha256-[A-Za-z0-9+/=]+$|^[0-9a-f]{64}$/.test(manifest.artifact_digest)) failures.push('run manifest: artifact_digest must be a sha256 (hex or SRI)');
  const expectedCorpus = corpusDigest(cases);
  if (manifest.corpus_digest && manifest.corpus_digest !== expectedCorpus) failures.push(`run manifest: corpus_digest ${manifest.corpus_digest.slice(0, 12)}… does not match cases.json (${expectedCorpus.slice(0, 12)}…)`);
  const hosts = (contract.measurability?.hosts ?? []).map(h => h.host);
  if (manifest.host && !hosts.includes(manifest.host)) failures.push(`run manifest: host ${manifest.host} is not one the contract measured`);
  const prov = manifest.usage_provenance;
  if (prov) {
    for (const arm of Object.keys(contract.arms ?? {})) {
      const ledger = prov[arm];
      if (!ledger) { failures.push(`run manifest: usage_provenance.${arm} missing`); continue; }
      if (ledger.schema !== 'memesh-token-usage-ledger/1') failures.push(`usage_provenance.${arm}: not a usage-probe ledger`);
      if (!/^[0-9a-f]{64}$/.test(ledger.session?.transcript_sha256 ?? '')) failures.push(`usage_provenance.${arm}: transcript_sha256 missing`);
      if (!(ledger.turns?.length > 0)) failures.push(`usage_provenance.${arm}: no turns`);
      if (ledger.host && manifest.host && ledger.host !== manifest.host) failures.push(`usage_provenance.${arm}: ledger host ${ledger.host} ≠ manifest host ${manifest.host}`);
      // One arm, one model: a ledger that saw several models cannot be bound
      // to a single model identity, however the manifest labels it.
      if (!Array.isArray(ledger.models)) failures.push(`usage_provenance.${arm}: ledger has no models`);
      else if (manifest.model && (ledger.models.length !== 1 || ledger.models[0] !== manifest.model)) failures.push(`usage_provenance.${arm}: ledger models [${ledger.models.join(',')}] must be exactly the manifest model ${manifest.model}`);
    }
  }
  if (manifest.estimated_tokens !== undefined || manifest.char_count_tokens !== undefined) failures.push('run manifest: estimated/char-count tokens are diagnostics and may not appear in a result');
  if (official) {
    if (contract.statistics?.status !== 'frozen') failures.push('official run refused: contract.statistics.status is not frozen (pilot first, then freeze)');
    if (manifest.mode !== 'official') failures.push('official run refused: manifest.mode must be official');
  }
  return failures;
}

function main(argv) {
  const args = argv.slice(2);
  const runIdx = args.indexOf('--run');
  const official = args.includes('--official');
  if (official && runIdx < 0) {
    console.error('--official only means something with --run <manifest.json>: there is no run to refuse or accept');
    process.exit(2);
  }
  const contract = readJson(path.join(here, 'contract.json'));
  const cases = readJson(path.join(here, 'cases.json'));
  let failures = validateContract(contract, cases);
  if (runIdx >= 0) {
    const file = args[runIdx + 1];
    if (!file) { console.error('--run needs a manifest path'); process.exit(2); }
    failures = failures.concat(validateRunManifest(readJson(path.resolve(file)), contract, cases, { official }));
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`✗ ${f}`);
    process.exit(1);
  }
  console.log(`✓ token benchmark contract: ${cases.cases.length} cases cover ${contract.required_case_categories.length} categories; verdict ${contract.measurability.verdict}; statistics ${contract.statistics.status}; corpus ${corpusDigest(cases).slice(0, 12)}…${runIdx >= 0 ? '; run manifest bound' : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv);
