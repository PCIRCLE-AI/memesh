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
// so zero exit patterns do not pretend to prove coverage: output() must
// record an outcome, AND every stdout write in the file must lie inside
// output() — an emit that bypasses the funnel bypasses its record too.
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

/**
 * The same list as CAPTURE_HOOKS in src/core/capture-liveness.ts, copied
 * rather than imported: this gate must run on a fresh clone, before `dist/`
 * exists, and a gate that depends on the build it polices proves nothing.
 */
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
const OUTCOME_HELPER_DEF_RE = /^(?:export\s+)?(?:async\s+)?function\s+(?:record|exit0|pass)\s*\(/;

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
  let braceDepth = 0;
  let helperDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // maskLexicalNoise() already blanked every comment, so a comment line
    // arrives here as pure whitespace — blankness is the only skip needed.
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (helperDepth > 0) {
      const delta = braceDelta(line);
      braceDepth += delta;
      helperDepth += delta;
      continue;
    }
    if (OUTCOME_HELPER_DEF_RE.test(trimmed)) {
      const delta = braceDelta(line);
      braceDepth += delta;
      helperDepth = Math.max(delta, 0);
      continue;
    }

    // user-prompt-intent defines its record helper as an arrow function;
    // do not let the helper's own recordHookOutcome call credit the hook.
    if (/^(?:const|let|var)\s+record\s*=.*=>/.test(trimmed)) {
      while (i < lines.length && !lines[i].includes(';')) i++;
      continue;
    }

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
    braceDepth += braceDelta(line);
    if (braceDepth < 0) throw new Error('cannot analyze hook source: closing brace has no opening brace');
  }
  if (braceDepth !== 0 || helperDepth !== 0) {
    throw new Error('cannot analyze hook source: braces are unbalanced');
  }
  return uncovered;
}

const LITERAL_SKIP_RE = /(?<![\w$.])record\s*\(\s*['"]skipped['"]\s*,\s*['"`]/;

/**
 * Line numbers (1-based) where a hook records a skip with a LITERAL reason
 * instead of a SKIP_REASONS constant. Doctor quotes only reasons listed in
 * SKIP_REASONS (anything else renders as "unrecognised reason", so a planted
 * record cannot put text in the report); a literal here would ship a reason
 * doctor refuses to show. Comment lines are ignored.
 */
export function findLiteralSkipReasons(source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (LITERAL_SKIP_RE.test(line)) out.push(i + 1);
  });
  return out;
}

const STDOUT_WRITE_RE = /(?<![\w$])(?:console\.log|process\.stdout\.write)\s*\(/g;

/**
 * The output() funnel check for session-start. Returns an error string, or
 * null when output() records an outcome and is the ONLY place that writes
 * to stdout. Pure (source in, verdict out) so a mutation can be fed to it.
 */
export function validateSessionStart(source) {
  const masked = maskLexicalNoise(source);
  const outputStart = masked.search(/function\s+output\s*\(/);
  if (outputStart < 0) return 'session-start has no output() funnel';
  // The funnel's exact body, by brace matching — not a fixed-size window,
  // which let a record in the NEXT function vouch for this one.
  const open = masked.indexOf('{', outputStart);
  if (open < 0) return 'session-start output() funnel has no body';
  let depth = 0;
  let close = -1;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return 'session-start output() funnel body is unbalanced';
  const body = masked.slice(open, close + 1);
  if (!/(?:recordHookOutcome|\brecord)\s*\(/.test(body)) {
    return 'session-start output() funnel has no outcome record';
  }
  for (const m of masked.matchAll(STDOUT_WRITE_RE)) {
    if (m.index < open || m.index > close) {
      const line = masked.slice(0, m.index).split('\n').length;
      return `line ${line} writes to stdout outside output(), bypassing its outcome record`;
    }
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
      for (const line of findLiteralSkipReasons(source)) {
        violations.push(`scripts/hooks/${hook}.js:${line}: skip reason is a literal — add it to SKIP_REASONS in src/core/capture-liveness.ts and record the constant`);
      }
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
        `  Every early exit must be preceded by a record(...) call, with a SKIP_REASONS constant for a skip.`,
    );
    process.exit(1);
  }
  const explicit = CAPTURE_HOOKS.filter((h) => h !== 'session-start').length;
  console.log(`✓ ${explicit} explicit-exit hooks record outcomes; session-start writes stdout only through output(), which records an outcome (${CAPTURE_HOOKS.length} hooks)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
