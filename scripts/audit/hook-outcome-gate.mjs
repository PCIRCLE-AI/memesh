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

const LIVENESS_SOURCE = path.join(REPO, 'src', 'core', 'capture-liveness.ts');

/**
 * The hook names, READ from capture-liveness.ts rather than copied.
 *
 * This list used to be a hand-maintained copy with a comment claiming it
 * mirrored CAPTURE_HOOKS, and nothing tied the two together. It drifted
 * exactly as a copy does: CAPTURE_HOOKS grew to ten names and this stayed at
 * eight, so the gate silently stopped covering the two newest recording
 * paths — including the 361-line one #324 added. A gate that cannot see a new
 * background path is worth less than no gate, because it reports success.
 *
 * Throws on an empty parse. An empty list would make every loop below run
 * zero times and the gate print a cheerful tick, which is the same failure
 * wearing a different hat.
 */
export function readCaptureHooks() {
  const source = fs.readFileSync(LIVENESS_SOURCE, 'utf8');
  const block = source.match(/export const CAPTURE_HOOKS = \[([\s\S]*?)\] as const;/);
  if (!block) throw new Error('cannot find CAPTURE_HOOKS in src/core/capture-liveness.ts');
  // Comment lines first. The block carries prose containing apostrophes
  // ("session-summary's window"), and matching quotes across those produced
  // hook "names" made of half a sentence.
  const code = block[1]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const names = [...code.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error('parsed CAPTURE_HOOKS as empty — the gate would vacuously pass');
  return names;
}

/**
 * Hook names that are NOT files. `note-ingest` and `remember-nudge` are
 * recorded by `_stop-notes.js`, which the Stop hook calls once per Stop;
 * there is no `note-ingest.js` to look for, and looking for one is the wrong
 * fix — it makes the gate fail on a file that was never meant to exist.
 *
 * Declared, not inferred: a name with no file must be claimed by a named
 * owner here, so the next recording helper cannot pass by simply having no
 * file of its own. `main()` fails on a parsed name that is neither a file nor
 * claimed here, and on a claim for a name CAPTURE_HOOKS does not contain.
 */
const HELPER_OWNED_HOOKS = {
  'note-ingest': '_stop-notes.js',
  'remember-nudge': '_stop-notes.js',
};

/**
 * A helper that RETURNS its outcome instead of exiting needs a different
 * criterion, because the one above is written in terms of exits: `EXIT_RE`
 * looks for `exit0()` / `pass()` / `process.exit()`, and `_stop-notes.js` has
 * none of them — it hands `{ outcome, reason }` back to its caller, which
 * records it. So the rule for these functions is on their RETURNS: every one
 * must carry a `reason`. A new early `return { outcome: 'skipped' }` with
 * nothing to say is exactly the silent skip this gate exists to forbid, and
 * it would sail through an exit-shaped check.
 */
const RETURNING_DECISION_FUNCTIONS = {
  '_stop-notes.js': ['runNoteIngestion', 'decideNudge'],
};

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
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      continue;
    }

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

/**
 * Line numbers (1-based) of `return` statements inside `fnName` that do not
 * carry a `reason`. Pure, so a mutation can be fed to it without touching the
 * filesystem. Returns null when the function is not found at all — a rename
 * must fail the gate rather than silently check nothing.
 */
export function findUnreasonedReturns(source, fnName) {
  const masked = maskLexicalNoise(source);
  const defRe = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
  const match = defRe.exec(masked);
  if (!match) return null;
  // Step over the PARAMETER LIST before looking for the body. These functions
  // destructure their argument — `runNoteIngestion({ memoryDir, … })` — so
  // the first `{` after the name opens the parameter object, and brace
  // matching from there returns the parameter list as the "body": no returns
  // inside it, so the check passed while checking nothing. Measured: an
  // unrecorded `return { outcome: 'skipped' }` injected into
  // runNoteIngestion left the gate at exit 0.
  let paren = 0;
  let afterParams = -1;
  for (let i = match.index + match[0].length - 1; i < masked.length; i++) {
    if (masked[i] === '(') paren++;
    else if (masked[i] === ')' && --paren === 0) { afterParams = i; break; }
  }
  if (afterParams < 0) return null;
  const open = masked.indexOf('{', afterParams);
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return null;
  const body = masked.slice(open, close + 1);
  const out = [];
  for (const m of body.matchAll(/(?<![\w$.])return(?![\w$])/g)) {
    // The statement runs to the first `;` at the depth the return started at,
    // so a `;` inside a nested object or call does not end it early.
    let d = 0;
    let end = body.length;
    for (let i = m.index; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{' || ch === '(' || ch === '[') d++;
      else if (ch === '}' || ch === ')' || ch === ']') d--;
      else if (ch === ';' && d === 0) { end = i; break; }
      if (d < 0) { end = i; break; }
    }
    const statement = body.slice(m.index, end);
    if (!/(?<![\w$.])reason(?![\w$])/.test(statement)) {
      out.push(masked.slice(0, open + m.index).split('\n').length);
    }
  }
  return out;
}

export function main() {
  const violations = [];
  const captureHooks = readCaptureHooks();

  // Both directions. A parsed name with neither a file nor a declared owner
  // is a recording path nobody checks; a declared owner for a name that is
  // not in CAPTURE_HOOKS is a stale claim that would keep the first check
  // looking satisfied after a rename.
  const fileHooks = [];
  for (const hook of captureHooks) {
    const file = path.join(REPO, 'scripts', 'hooks', `${hook}.js`);
    if (fs.existsSync(file)) fileHooks.push(hook);
    else if (!HELPER_OWNED_HOOKS[hook]) {
      violations.push(
        `${hook}: named in CAPTURE_HOOKS with no scripts/hooks/${hook}.js and no owner in HELPER_OWNED_HOOKS — `
          + 'a recording path this gate cannot see',
      );
    }
  }
  for (const hook of Object.keys(HELPER_OWNED_HOOKS)) {
    if (!captureHooks.includes(hook)) {
      violations.push(`${hook}: claimed in HELPER_OWNED_HOOKS but absent from CAPTURE_HOOKS — a stale claim`);
    }
  }

  for (const hook of fileHooks) {
    const rel = `scripts/hooks/${hook}.js`;
    try {
      // Inside the try: an unreadable file must be reported as a violation,
      // not thrown out of main() where it looks like a crashed gate.
      const source = fs.readFileSync(path.join(REPO, 'scripts', 'hooks', `${hook}.js`), 'utf8');
      const uncovered = findUncoveredExits(source);
      for (const line of uncovered) violations.push(`${rel}:${line}`);
      for (const line of findLiteralSkipReasons(source)) {
        violations.push(`${rel}:${line}: skip reason is a literal — add it to SKIP_REASONS in src/core/capture-liveness.ts and record the constant`);
      }
      if (hook === 'session-start') {
        const funnelError = validateSessionStart(source);
        if (funnelError) violations.push(`${rel}: ${funnelError}`);
      }
    } catch (error) {
      violations.push(`${rel}: analysis failed (${error.message})`);
    }
  }

  // The returning helpers. Their outcome is a RETURN VALUE, so the exit-shaped
  // check above says nothing about them at all.
  for (const [basename, fns] of Object.entries(RETURNING_DECISION_FUNCTIONS)) {
    const rel = `scripts/hooks/${basename}`;
    try {
      const source = fs.readFileSync(path.join(REPO, 'scripts', 'hooks', basename), 'utf8');
      for (const fn of fns) {
        const lines = findUnreasonedReturns(source, fn);
        if (lines === null) {
          violations.push(`${rel}: ${fn}() not found — this gate checks its returns and cannot`);
          continue;
        }
        for (const line of lines) {
          violations.push(`${rel}:${line}: ${fn}() returns without a reason — the caller records that as an outcome nobody can explain`);
        }
      }
    } catch (error) {
      violations.push(`${rel}: analysis failed (${error.message})`);
    }
  }

  // Every helper-owned hook name must actually be recorded by its owner.
  for (const [hook, basename] of Object.entries(HELPER_OWNED_HOOKS)) {
    const rel = `scripts/hooks/${basename}`;
    try {
      const source = fs.readFileSync(path.join(REPO, 'scripts', 'hooks', basename), 'utf8');
      if (!source.includes(`hook: '${hook}'`)) {
        violations.push(`${rel}: records no outcome for '${hook}', which it is declared to own`);
      }
    } catch (error) {
      violations.push(`${rel}: analysis failed (${error.message})`);
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
  const explicit = fileHooks.filter((h) => h !== 'session-start').length;
  const helpers = Object.keys(RETURNING_DECISION_FUNCTIONS).length;
  console.log(
    `✓ ${explicit} explicit-exit hooks record outcomes; session-start writes stdout only through output(), `
      + `which records an outcome; ${helpers} returning helper(s) return a reason on every path `
      + `(${captureHooks.length} hooks in CAPTURE_HOOKS)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
