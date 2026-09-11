import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { findUncoveredExits, validateSessionStart } from '../../scripts/audit/hook-outcome-gate.mjs';

/**
 * The gate behind #328 item-1: an exit with no outcome record before it is
 * the "silent skip" that made two days of `git commit -q` indistinguishable
 * from a broken hook. findUncoveredExits is the pure half; this pins it both
 * directions — it must flag the uncovered exit and stay quiet on a covered one.
 */
describe('capture-hook outcome gate', () => {
  it('flags an early exit with no record before it', () => {
    const source = [
      'process.stdin.on("end", () => {', // 1
      '  const data = JSON.parse(input);', // 2
      '  if (!data.tool_input) {', // 3
      '    return exit0();', // 4  <-- no record
      '  }', // 5
      '});', // 6
      'function exit0() { process.exit(0); }', // 7
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([4]);
  });

  it('does not flag an exit preceded by a record', () => {
    const source = [
      'process.stdin.on("end", () => {', // 1
      '  const data = JSON.parse(input);', // 2
      '  if (!data.tool_input) {', // 3
      '    record("skipped", "tool_input absent");', // 4
      '    return exit0();', // 5
      '  }', // 6
      '});', // 7
      'function exit0() { process.exit(0); }', // 8
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([]);
  });

  it('flags an exit inserted after the last record with nothing in between', () => {
    const source = [
      'record("wrote", undefined, "x");', // 1
      'exit0();', // 2  <- covered (record at line 1)
      'if (late) return pass();', // 3  <-- no record after line 2
      'function exit0() { process.exit(0); }', // 4
      'function pass() { process.exit(0); }', // 5
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([3]);
  });

  it('keeps the record that covers two successive exits', () => {
    // One record, then two exits back to back: the first exit is covered,
    // the second is not — the gate must distinguish them.
    const source = [
      'record("error", "boom");', // 1
      'if (a) return exit0();', // 2  <- covered
      'return exit0();', // 3  <-- not covered
      'function exit0() { process.exit(0); }', // 4
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([3]);
  });

  it('ignores the helper definition body, which is not a hook exit', () => {
    const source = [
      'function exit0() {', // 1
      '  process.exit(0);', // 2
      '}', // 3
      'function pass() {', // 4
      '  process.exit(0);', // 5
      '}', // 6
      'record("wrote");', // 7
      'exit0();', // 8  <- covered
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([]);
  });

  it('does not let braces or exit words inside strings/comments alter analysis', () => {
    const source = [
      'function helper() {',
      '  const text = "} exit0() record(";',
      '  // { process.exit(0) record(',
      '}',
      'record("skipped", "real");',
      'return exit0();',
      'function exit0() { process.exit(0); }',
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([]);
  });

  it('does not let an arrow record helper credit an uncovered exit', () => {
    const source = [
      'const record = (outcome) =>',
      '  recordHookOutcome(outcome);',
      'return exit0();',
      'function exit0() { process.exit(0); }',
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([3]);
  });

  it('recognizes exit calls with arguments, spaces, and multiline parentheses', () => {
    const source = [
      'record("a");',
      'exit0 (payload);',
      'record("b");',
      'process.exit(code);',
      'record("c");',
      'process.exit(',
      '  0',
      ');',
      'function exit0() { process.exit(0); }',
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([]);
  });

  it('fails closed when a function body is unbalanced', () => {
    const source = [
      'function helper() {',
      '  record("inside");',
    ].join('\n');
    expect(() => findUncoveredExits(source)).toThrow(/unbalanced/);
  });

  it('still audits ordinary named function bodies', () => {
    const source = [
      'function handle(input) {',
      '  if (!input) process.exit(0);',
      '}',
    ].join('\n');
    expect(findUncoveredExits(source)).toEqual([2]);
  });
});

/**
 * session-start's funnel check (#327 C4). Its catch used to print its own
 * `console.log(JSON.stringify({ systemMessage }))`, bypassing output() — and
 * the gate, which only looked for a record somewhere near output(), passed.
 */
describe('session-start output() funnel gate', () => {
  const real = fs.readFileSync(path.resolve('scripts/hooks/session-start.js'), 'utf8');

  it('passes the real session-start', () => {
    expect(validateSessionStart(real)).toBeNull();
  });

  it('M3: a stdout write outside output() is flagged', () => {
    // The exact shape that shipped: an emit in the catch, beside the funnel.
    const anchor = '  } finally {\n    // ── Auto-update + cache refresh';
    expect(real.includes(anchor), 'fixture anchor moved — update the mutation').toBe(true);
    const mutant = real.replace(
      anchor,
      '    console.log(JSON.stringify({ systemMessage: "bypass" }));\n' + anchor,
    );
    expect(validateSessionStart(mutant)).toMatch(/writes to stdout outside output\(\)/);
  });

  it('a process.stdout.write outside output() is flagged too', () => {
    const src = [
      'function output(text) {',
      '  console.log(JSON.stringify({ systemMessage: text }));',
      '  recordHookOutcome(process.env, { hook: "session-start", outcome: "wrote" });',
      '}',
      'process.stdout.write("{}");',
    ].join('\n');
    expect(validateSessionStart(src)).toMatch(/line 5/);
  });

  it('a record in a LATER function does not vouch for an output() that records nothing', () => {
    const src = [
      'function output(text) {',
      '  console.log(JSON.stringify({ systemMessage: text }));',
      '}',
      'function other() { recordHookOutcome(process.env, {}); }',
    ].join('\n');
    expect(validateSessionStart(src)).toMatch(/no outcome record/);
  });
});
