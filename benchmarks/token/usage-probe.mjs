#!/usr/bin/env node
// Token-usage measurability probe — PUBLIC EVIDENCE PACKAGE (#251)
//
// Reads the session transcript an agent host writes on disk and turns its
// per-request `usage` records into one machine-readable ledger. Nothing is
// estimated: every number is copied from the field the host itself recorded
// after the model call. Character counts, byte counts and tokenizer guesses
// are deliberately NOT computed here — they are diagnostics, and the contract
// in CONTRACT.md forbids presenting them as token or billing results.
//
// Supported transcript shapes (detected from the first parsable line):
//   claude-code — `~/.claude/projects/<cwd-key>/<session>.jsonl`; every
//                 assistant record carries `message.usage` with
//                 input_tokens, cache_creation_input_tokens,
//                 cache_read_input_tokens, output_tokens and `message.model`.
//                 One record per API request (requestId).
//   codex       — `~/.codex/sessions/**/<session>.jsonl`; `token_count`
//                 events carry `info.last_token_usage` with input_tokens,
//                 cached_input_tokens, cache_write_input_tokens,
//                 output_tokens, reasoning_output_tokens.
//
// The ledger never contains prompt or completion text. It carries only the
// numbers, the model/host identity, the session boundary (the file) and a
// SHA-256 of the transcript so a reader can prove which file produced it.
//
// Usage:
//   node benchmarks/token/usage-probe.mjs <transcript.jsonl> [--arm <label>] [--json]
//
// Exit codes: 0 ledger produced; 1 usage missing or unreadable — the arm is
// UNMEASURABLE on this host and the ledger says so instead of guessing.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Fields a ledger turn must carry for the contract to accept it. */
export const REQUIRED_TURN_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* a partial trailing line is not usage */ }
  }
  return out;
}

function detectHost(records) {
  if (records.some(r => r && r.type === 'assistant' && r.message && typeof r.message === 'object')) return 'claude-code';
  if (records.some(r => r && (r.type === 'token_count' || (r.type === 'event_msg' && r.payload && r.payload.type === 'token_count')))) return 'codex';
  return null;
}

function int(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/** Claude Code: one turn per API request. The host writes one assistant
 *  record PER CONTENT BLOCK (thinking, tool_use, text) and they share a
 *  requestId and an identical usage object, so usage is taken once per
 *  requestId while tool_use names are collected across all of its records. */
function claudeTurns(records) {
  const byRequest = new Map();
  for (const r of records) {
    if (r.type !== 'assistant' || !r.message || !r.message.usage) continue;
    const key = r.requestId || r.uuid;
    const names = Array.isArray(r.message.content)
      ? r.message.content.filter(c => c && c.type === 'tool_use').map(c => c.name)
      : [];
    const existing = byRequest.get(key);
    if (existing) { existing.tool_uses.push(...names); continue; }
    const u = r.message.usage;
    byRequest.set(key, {
      request_id: r.requestId || null,
      timestamp: r.timestamp || null,
      model: r.message.model || null,
      input_tokens: int(u.input_tokens),
      cache_read_input_tokens: int(u.cache_read_input_tokens),
      cache_creation_input_tokens: int(u.cache_creation_input_tokens),
      output_tokens: int(u.output_tokens),
      tool_uses: names,
    });
  }
  return [...byRequest.values()];
}

/** Codex: one turn per token_count event that carries last_token_usage. */
function codexTurns(records) {
  const turns = [];
  let model = null;
  let pendingTools = [];
  for (const r of records) {
    const payload = r.type === 'event_msg' ? r.payload : r;
    if (r.type === 'turn_context' && r.payload && r.payload.model) model = r.payload.model;
    // Tool calls are `response_item` records that precede the token_count
    // event for the request that produced them.
    if (r.type === 'response_item' && r.payload && r.payload.type === 'function_call' && r.payload.name) {
      pendingTools.push(r.payload.name);
      continue;
    }
    if (!payload || payload.type !== 'token_count' || !payload.info || !payload.info.last_token_usage) continue;
    const u = payload.info.last_token_usage;
    const tool_uses = pendingTools;
    pendingTools = [];
    turns.push({
      request_id: null,
      timestamp: r.timestamp || null,
      model,
      // Codex reports input_tokens INCLUSIVE of cached_input_tokens; the
      // ledger keeps the host's own partition and names the convention below.
      input_tokens: int(u.input_tokens),
      cache_read_input_tokens: int(u.cached_input_tokens),
      cache_creation_input_tokens: int(u.cache_write_input_tokens),
      output_tokens: int(u.output_tokens),
      reasoning_output_tokens: int(u.reasoning_output_tokens),
      tool_uses,
    });
  }
  return turns;
}

/**
 * Build the ledger for one transcript. Pure: no I/O beyond reading the file.
 * @returns {{measurable: boolean, reason?: string, ledger?: object}}
 */
export function probeTranscript(file, { arm = null } = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (err) {
    return { measurable: false, reason: `cannot read transcript: ${err.code || err.message}` };
  }
  const records = parseLines(buf.toString('utf8'));
  const host = detectHost(records);
  if (!host) return { measurable: false, reason: 'transcript shape not recognised (neither claude-code nor codex)' };
  const turns = host === 'claude-code' ? claudeTurns(records) : codexTurns(records);
  if (turns.length === 0) return { measurable: false, reason: `${host}: no usage records in transcript` };
  const missing = turns.flatMap((t, i) => REQUIRED_TURN_FIELDS.filter(f => t[f] === null).map(f => `turn ${i}: ${f}`));
  if (missing.length > 0) return { measurable: false, reason: `usage record incomplete — ${missing.join(', ')}` };
  const models = [...new Set(turns.map(t => t.model).filter(Boolean))];
  if (models.length === 0) return { measurable: false, reason: `${host}: no model identity in transcript` };

  // Context tokens = everything the model read for that request, whichever
  // cache tier it came from. Cache tiers change the PRICE, not what the model
  // read, and a paired comparison must not reward the arm that happened to
  // run second and hit the cache the first arm warmed.
  const contextOf = host === 'claude-code'
    ? t => t.input_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens
    : t => t.input_tokens; // codex input_tokens already includes cached_input_tokens
  const total = (f) => turns.reduce((n, t) => n + (t[f] || 0), 0);
  const ledger = {
    schema: 'memesh-token-usage-ledger/1',
    arm,
    host,
    host_usage_convention: host === 'claude-code'
      ? 'input_tokens excludes cache_read and cache_creation; context = sum of the three'
      : 'input_tokens includes cached_input_tokens; context = input_tokens',
    models,
    session: {
      transcript: path.basename(file),
      transcript_sha256: sha256(buf),
      boundary: 'one transcript file = one host session; turns are API requests in order',
    },
    turns,
    totals: {
      requests: turns.length,
      input_tokens: total('input_tokens'),
      cache_read_input_tokens: total('cache_read_input_tokens'),
      cache_creation_input_tokens: total('cache_creation_input_tokens'),
      output_tokens: total('output_tokens'),
      context_tokens: turns.reduce((n, t) => n + contextOf(t), 0),
      tool_calls: turns.reduce((n, t) => n + t.tool_uses.length, 0),
    },
    limits: [
      'tool definitions are inside input/cache tokens and are not itemised by either host; their cost is only visible as a difference between arms',
      'cache_read vs cache_creation depends on what ran before on the same account; compare context_tokens, never input_tokens alone',
      'thinking/reasoning tokens are included in output_tokens by both hosts',
    ],
  };
  return { measurable: true, ledger };
}

function main(argv) {
  const args = argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const armIdx = args.indexOf('--arm');
  const arm = armIdx >= 0 ? args[armIdx + 1] : null;
  if (!file) {
    console.error('usage: node benchmarks/token/usage-probe.mjs <transcript.jsonl> [--arm <label>] [--json]');
    process.exit(2);
  }
  const result = probeTranscript(path.resolve(file), { arm });
  if (!result.measurable) {
    console.error(`UNMEASURABLE: ${result.reason}`);
    process.exit(1);
  }
  const { ledger } = result;
  if (args.includes('--json')) {
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }
  const t = ledger.totals;
  console.log(`${arm ? `[${arm}] ` : ''}${ledger.host} ${ledger.models.join(',')} — ${t.requests} request(s)`);
  console.log(`  context_tokens=${t.context_tokens} (input=${t.input_tokens} cache_read=${t.cache_read_input_tokens} cache_creation=${t.cache_creation_input_tokens}) output_tokens=${t.output_tokens} tool_calls=${t.tool_calls}`);
  for (const [i, turn] of ledger.turns.entries()) {
    console.log(`  #${i + 1} in=${turn.input_tokens} read=${turn.cache_read_input_tokens} create=${turn.cache_creation_input_tokens} out=${turn.output_tokens}${turn.tool_uses.length ? ` tools=${turn.tool_uses.join(',')}` : ''}`);
  }
  console.log(`  transcript sha256=${ledger.session.transcript_sha256}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv);
