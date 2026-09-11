#!/usr/bin/env node
// =============================================================================
// Capture-hook outcome gate (#327 + #328 item-1)
// =============================================================================
//
// The rule "a capture path may skip, but never silently" is prose until a
// gate enforces it. This is that gate: every EXIT in a capture hook must be
// preceded, since the previous exit, by an outcome record. A new `return
// exit0()` dropped into a hook without its `record(...)` makes this fail.
//
// The invariant, stated precisely: between any two exits of a hook (or from
// the top of the file to its first exit) there must be at least one record
// call (`record(` / `recordHookOutcome(`). That is the observable form of
// "no silent skip" — every exit is reached through at least one recorded
// outcome, so a path that exits without saying why cannot exist.
//
// session-start has no explicit process exit; its returns funnel through its
// single `output()` emit point. It gets a separate output-funnel check below,
// so zero exit patterns do not pretend to prove coverage.
//
// Exit 1 on the first uncovered exit; 0 when every exit is covered.
//
//   node scripts/audit/hook-outcome-gate.mjs
//
// Covered by tests/audit/hook-outcome-gate.test.ts, which feeds an uncovered
// exit and requires exit 1 (the red light), then feeds the real hooks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The hooks that own capture exits. Mirrors CAPTURE_HOOKS minus the mirror. */
const CAPTURE_HOOKS = [
  'post-commit',
  'session-summary',
  'pre-compact',
  'pre-edit-recall',
  'user-prompt-intent',
  'decision-nudge',
  'guard-check',
  'session-start',
];

const EXIT_RE = /(?<![\w$.])(?:exit0|pass)\s*\(|(?<![\w$.])process\.exit\s*\(/;
const RECORD_RE = /(?<![\w$.])(?:record|recordHookOutcome)\s*\(/;
// Any `function`-keyword definition (the `record` helper, `exit0`, `pass`,
// …). Its body must be skipped, or the `recordHookOutcome(...)` inside the
// `record` helper would count as a hook record and every uncovered exit
// would hide behind it.
const FUNCTION_DEF_RE = /^(?:export\s+)?(?:async\s+)?function\s+/;

/** Mask strings, comments, and regex literals while preserving newlines. */
function maskLexicalNoise(source) {
  let out = '';
  let state = 'code';
  let escaped = false;
  let previousSignificant = '';
  const mask = (char) => { out += char === '\n' ? '\n' : ' '; };
  const canStartRegex = () => !previousSignificant || /[=([{,:;!&|?]/.test(previousSignificant);

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] ?? '';
    if (state === 'line-comment') {
      mask(ch);
      if (ch === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      mask(ch);
      if (ch === '*' && next === '/') {
        mask(next); i++; state = 'code';
      }
      continue;
    }
    if (state === 'string' || state === 'template' || state === 'regex') {
      mask(ch);
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if ((state === 'string' && (ch === "'" || ch === '"'))
        || (state === 'template' && ch === '`')
        || (state === 'regex' && ch === '/')) state = 'code';
      continue;
    }
    if (ch === '/' && next === '/') {
      mask(ch); mask(next); i++; state = 'line-comment'; continue;
    }
    if (ch === '/' && next === '*') {
      mask(ch); mask(next); i++; state = 'block-comment'; continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      mask(ch); state = ch === '`' ? 'template' : 'string'; escaped = false; continue;
    }
    if (ch === '/' && canStartRegex()) {
      mask(ch); state = 'regex'; escaped = false; continue;
    }
    out += ch;
    if (!/\s/.test(ch)) previousSignificant = ch;
  }
  return out;
}

/** Net brace delta on a line, so a function body can be skipped correctly. */
function braceDelta(line) {
  return (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
}

/**
 * Line numbers (1-based) of exits that have no outcome record between them
 * and the previous exit (or the top of the file). Pure so the bound is
 * testable without the filesystem.
 */
export function findUncoveredExits(source) {
  const lines = maskLexicalNoise(source).split('\n');
  const uncovered = [];
  let lastExitLine = -1;
  let lastRecordLine = -1;
  let fnDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      continue;
    }

    if (fnDepth > 0) {
      fnDepth += braceDelta(line);
      continue;
    }
    if (FUNCTION_DEF_RE.test(trimmed)) {
      fnDepth = braceDelta(line);
      continue;
    }

    // user-prompt-intent defines its record helper as an arrow function;
    // do not let the helper's own recordHookOutcome call credit the hook.
    if (/^(?:const|let|var)\s+record\s*=.*=>/.test(trimmed)) continue;

    if (EXIT_RE.test(line)) {
      if (lastRecordLine <= lastExitLine) {
        uncovered.push(i + 1);
      }
      lastExitLine = i;
      continue;
    }
    if (RECORD_RE.test(line)) {
      lastRecordLine = i;
    }
  }
  if (fnDepth !== 0) {
    throw new Error('cannot analyze hook source: function body is unbalanced');
  }
  return uncovered;
}

function validateSessionStart(source) {
  const masked = maskLexicalNoise(source);
  const outputStart = masked.search(/function\s+output\s*\(/);
  if (outputStart < 0) return 'session-start has no output() funnel';
  const outputTail = masked.slice(outputStart, outputStart + 2000);
  if (!/(?:recordHookOutcome|\brecord)\s*\(/.test(outputTail)) {
    return 'session-start output() funnel has no outcome record';
  }
  return null;
}

export function main() {
  const violations = [];
  for (const hook of CAPTURE_HOOKS) {
    const file = path.join(REPO, 'scripts', 'hooks', `${hook}.js`);
    const source = fs.readFileSync(file, 'utf8');
    try {
      const uncovered = findUncoveredExits(source);
      for (const line of uncovered) violations.push(`scripts/hooks/${hook}.js:${line}`);
      if (hook === 'session-start') {
        const funnelError = validateSessionStart(source);
        if (funnelError) violations.push(`scripts/hooks/${hook}.js: ${funnelError}`);
      }
    } catch (error) {
      violations.push(`scripts/hooks/${hook}.js: analysis failed (${error.message})`);
    }
  }
  if (violations.length > 0) {
    console.error(
      `✗ capture hooks exit without an outcome record — the "silent skip" this gate exists to forbid:\n  ` +
        `${violations.join('\n  ')}\n` +
        `  Every early exit must be preceded by a record(...) call.`,
    );
    process.exit(1);
  }
  console.log(`✓ 7 explicit-exit hooks record outcomes; session-start output funnel verified (8 hooks)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
