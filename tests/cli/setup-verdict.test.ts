/**
 * `memesh setup`: ONE rule for how a run ends and what its exit code is, whichever way it was run (#528):
 *
 *  - a present host that can be checked and is not wired, no host at all, or no host that could be
 *    confirmed wired: exit 1
 *  - everything that can be checked is wired: exit 0, and a host that could not be checked is named
 *    with how to check it
 *
 * Each row is a machine (fake agent commands on a throwaway PATH, a throwaway HOME) and the answer
 * `setup --check`, `setup` (not on a terminal) and `setup --yes` must each give. The rows are in
 * tests/helpers/setup-machines.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeMachine, type Machine } from '../helpers/cli-machine.js';
import { SETUP_ROWS, buildSetupMachine, type Expectation } from '../helpers/setup-machines.js';

const machines: Machine[] = [];
afterEach(() => { for (const m of machines.splice(0)) m.cleanup(); });

describe.skipIf(process.platform === 'win32')('setup: the closing sentence and exit code, machine by machine', () => {
  for (const row of SETUP_ROWS) {
    for (const [how, args, expected] of [
      ['--check', ['setup', '--check'], row.check],
      ['no flag', ['setup'], row.plain],
      ['--yes', ['setup', '--yes'], row.yes],
    ] as Array<[string, string[], Expectation]>) {
      it(`${row.name}: setup ${how} exits ${expected[0]}`, () => {
        const m = makeMachine({ MEMESH_SKIP_POST_INSTALL_JOURNEY: '1' });
        machines.push(m);
        buildSetupMachine(m, row.machine);
        const r = m.run(args);
        expect(r.status, r.text).toBe(expected[0]);
        for (const words of expected[1]) expect(r.text).toContain(words);
        // A run that failed, or could confirm nothing, never calls the machine wired.
        if (expected[0] === 1) expect(r.text).not.toContain('Everything present is wired');
      });
    }
  }
});

describe.skipIf(process.platform === 'win32')('setup --yes goes on after a step fails (#528)', () => {
  it('an install-hooks that is refused does not stop the MCP registration: the step is reported, the rest runs, exit 1', () => {
    const m = makeMachine({ MEMESH_SKIP_POST_INSTALL_JOURNEY: '1' });
    machines.push(m);
    buildSetupMachine(m, { claudeDir: true, claudeCommand: 'unregistered' });
    const settings = path.join(m.home, '.claude', 'settings.json');
    fs.writeFileSync(settings, '{ "hooks": ');
    const before = fs.readFileSync(settings, 'utf8');

    const r = m.run(['setup', '--yes']);
    expect(r.status, r.text).toBe(1);
    expect(r.stderr).toContain(`❌ settings file at ${settings} is not valid JSON; refusing to modify`);
    expect(m.calls(), 'the MCP registration was never attempted').toContain('claude mcp add -s user memesh memesh-mcp');
    expect(r.stdout).toContain('✅ done (claude mcp add -s user memesh memesh-mcp)');
    expect(r.stdout, 'the run did not get to its verification').toContain('After wiring:');
    expect(fs.readFileSync(settings, 'utf8'), 'the broken settings file was touched').toBe(before);
  });
});
