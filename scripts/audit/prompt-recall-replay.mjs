#!/usr/bin/env node
// =============================================================================
// Prompt-recall replay — what would the UserPromptSubmit recall hook inject?
// =============================================================================
//
// Reads a database (NEVER the live ~/.memesh one: pass a copy made with
// `sqlite3 <db> ".backup <copy>"`) and runs the very function the hook runs
// (scripts/hooks/_generated/prompt-recall.js) over a prompt or a file of them.
//
//   node scripts/audit/prompt-recall-replay.mjs --db <copy> --prompt "text" [--project <name>]
//   node scripts/audit/prompt-recall-replay.mjs --db <copy> --prompts prompts.jsonl [--sweep] [--spawn]
//
// Single prompt: prints exactly the block the hook would inject (nothing at all
// when nothing is strong enough) and exits 0.
//
// A prompts file is JSONL, one object per line: `prompt` (or `text`) and,
// optionally, `project` (the project tag value) or `cwd` (resolved to a
// project the way the hook does it). Prints the injection rate, the average
// characters injected per prompt and the in-process latency. `--sweep` adds the
// rate and size at other thresholds. `--spawn` also runs the real hook process
// once per prompt (against the copy, with a throwaway HOME) and reports the
// wall-clock latency a user would feel.
//
// Options: --min-coverage <0..1>  --min-terms <n>  --json (machine output)

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hooks = resolve(here, '../hooks');
const { openMemeshDb } = await import(join(hooks, '_shared.js'));
const { getProjectName } = await import(join(hooks, '_generated/core-paths.js'));
const { selectPromptRecall, scorePrompt, PROMPT_RECALL_MIN_COVERAGE, PROMPT_RECALL_MIN_TERMS } =
  await import(join(hooks, '_generated/prompt-recall.js'));

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sweep' || a === '--spawn' || a === '--json') out.flags.add(a.slice(2));
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function refuseLiveDatabase(dbPath) {
  const live = join(homedir(), '.memesh');
  const real = realpathSync(dbPath);
  let liveReal = live;
  try { liveReal = realpathSync(live); } catch { /* no live folder */ }
  if (real.startsWith(`${liveReal}/`)) {
    console.error('Refusing to read the live ~/.memesh database. Copy it first: sqlite3 <db> ".backup <copy>"');
    process.exit(2);
  }
}

function projectOf(row, fallback) {
  if (typeof row.project === 'string') return row.project;
  if (fallback !== undefined) return fallback;
  if (typeof row.cwd === 'string' && existsSync(row.cwd)) {
    try { return getProjectName(row.cwd); } catch { return null; }
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
if (!args.db || (!args.prompt && !args.prompts)) {
  console.error('usage: prompt-recall-replay.mjs --db <copy of knowledge-graph.db> (--prompt "text" | --prompts file.jsonl) [--project name] [--sweep] [--spawn] [--json]');
  process.exit(2);
}
const dbPath = resolve(args.db);
if (!existsSync(dbPath)) { console.error(`no such database: ${dbPath}`); process.exit(2); }
refuseLiveDatabase(dbPath);
const minCoverage = args['min-coverage'] === undefined ? undefined : Number(args['min-coverage']);
const minTerms = args['min-terms'] === undefined ? undefined : Number(args['min-terms']);
const db = openMemeshDb(dbPath, { readOnly: true });
const fixedProject = args.project;

if (args.prompt) {
  const result = selectPromptRecall(db, args.prompt, {
    project: fixedProject === undefined ? null : fixedProject, minCoverage, minTerms,
  });
  if (result.text) process.stdout.write(`${result.text}\n`);
  db.close();
  process.exit(0);
}

const rows = readFileSync(resolve(args.prompts), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .map((r) => ({ ...r, prompt: r.prompt ?? r.text }))
  .filter((r) => typeof r.prompt === 'string' && r.prompt.trim());

const ms = [];
const per = rows.map((row) => {
  const project = projectOf(row, fixedProject);
  const t0 = process.hrtime.bigint();
  const result = selectPromptRecall(db, row.prompt, { project, minCoverage, minTerms });
  ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  return { project, result };
});

function summarize(label, pick) {
  const injected = per.filter((p) => pick(p).length > 0);
  const chars = per.map((p) => pick(p).reduce((n, m) => n + m.textLength, 0));
  return {
    label,
    prompts: per.length,
    injected: injected.length,
    injectionRate: Number((injected.length / per.length).toFixed(3)),
    avgCharsPerPrompt: Number((chars.reduce((a, b) => a + b, 0) / per.length).toFixed(1)),
    avgCharsPerInjection: injected.length ? Number((chars.reduce((a, b) => a + b, 0) / injected.length).toFixed(1)) : 0,
  };
}

const effectiveCoverage = minCoverage ?? PROMPT_RECALL_MIN_COVERAGE;
const effectiveTerms = minTerms ?? PROMPT_RECALL_MIN_TERMS;
const report = {
  database: dbPath,
  threshold: { minCoverage: effectiveCoverage, minTerms: effectiveTerms },
  ...summarize('selected', (p) => (p.result.ids.length ? [{ textLength: p.result.text.length }] : [])),
  inProcessLatencyMs: {
    p50: Number(percentile([...ms].sort((a, b) => a - b), 0.5).toFixed(1)),
    p95: Number(percentile([...ms].sort((a, b) => a - b), 0.95).toFixed(1)),
    max: Number(Math.max(...ms).toFixed(1)),
  },
};

if (args.flags.has('sweep')) {
  const scoredPer = rows.map((row) => scorePrompt(db, row.prompt, { project: projectOf(row, fixedProject) }).scored);
  report.sweep = [];
  for (const cov of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    for (const terms of [1, 2, 3]) {
      const hits = scoredPer.map((s) => s.filter((m) => m.coverage >= cov && m.matched.length >= terms).length);
      const injected = hits.filter((n) => n > 0).length;
      report.sweep.push({ minCoverage: cov, minTerms: terms, injectionRate: Number((injected / rows.length).toFixed(3)) });
    }
  }
}

if (args.flags.has('spawn')) {
  const home = mkdtempSync(join(tmpdir(), 'prompt-recall-replay-'));
  mkdirSync(join(home, '.memesh'), { recursive: true });
  writeFileSync(join(home, '.memesh', 'config.json'), '{}');
  const wall = [];
  let injectedRuns = 0;
  const hook = join(hooks, 'prompt-recall.js');
  rows.forEach((row, i) => {
    const t0 = process.hrtime.bigint();
    const run = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt: row.prompt, session_id: `replay-${Date.now()}-${i}`, cwd: row.cwd ?? process.cwd(), hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    wall.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (run.stdout.trim()) injectedRuns++;
  });
  rmSync(home, { recursive: true, force: true });
  wall.sort((a, b) => a - b);
  report.spawn = {
    injected: injectedRuns,
    injectionRate: Number((injectedRuns / rows.length).toFixed(3)),
    wallClockMs: { p50: Number(percentile(wall, 0.5).toFixed(0)), p95: Number(percentile(wall, 0.95).toFixed(0)), max: Number(wall[wall.length - 1].toFixed(0)) },
  };
}

db.close();
console.log(args.flags.has('json') ? JSON.stringify(report) : JSON.stringify(report, null, 2));
