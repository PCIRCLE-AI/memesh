import { describe, it, expect } from 'vitest';
import { findUncoveredExits } from '../../scripts/audit/hook-outcome-gate.mjs';

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
});
