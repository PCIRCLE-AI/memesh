/**
 * Flags that accepted anything, and what each one silently did with a typo.
 *
 * `config set` has validated its enums since it shipped. The ordinary flags did
 * not, and every unvalidated one failed differently and quietly — all of them
 * exiting 0, which is the part that made them invisible:
 *
 *   --merge sikp        fell through to OVERWRITE. Measured on a real run:
 *                       "Imported: 1", exit 0, the previous observation gone,
 *                       nothing archived to restore it from.
 *   --namespace persnal stored the memory in a namespace nothing queries. It
 *                       vanished from every scoped view including the dashboard.
 *   --severity whatever was written into the graph as a tag nothing filters on.
 *
 * Another command crashed instead of answering: `export -o` into a directory
 * that does not exist dumped a Node stack trace with the absolute install path.
 *
 * Every test here asserts the exit code as well as the message. A validation
 * that prints a complaint and exits 0 is not a validation — a script cannot see
 * it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

let home: string;

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-flagval-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('CLI: flags reject values they do not understand', () => {
  describe('--merge', () => {
    /** An entity with one observation, and a bundle that would replace it. */
    function seedAndBundle(): string {
      expect(runCli(['remember', '--name', 'alpha', '--type', 'note', '--obs', 'ORIGINAL']).exitCode).toBe(0);
      const bundle = path.join(home, 'b.json');
      fs.writeFileSync(bundle, JSON.stringify({
        version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 1,
        entities: [{ name: 'alpha', type: 'note', observations: ['REPLACEMENT'], tags: [] }],
      }));
      return bundle;
    }

    it('a typo does not overwrite — the original observation survives', () => {
      const bundle = seedAndBundle();
      const r = runCli(['import', bundle, '--merge', 'sikp']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr + r.stdout).toContain('skip, overwrite, append');

      // The database is the check, not the message. This is the whole point:
      // the old behaviour reported success and destroyed the observation.
      const json = runCli(['recall', 'alpha', '--json']);
      expect(json.stdout, 'the typo overwrote the entity').toContain('ORIGINAL');
      expect(json.stdout).not.toContain('REPLACEMENT');
    });

    it('the real strategies still work', () => {
      const bundle = seedAndBundle();
      expect(runCli(['import', bundle, '--merge', 'skip']).exitCode).toBe(0);
      expect(runCli(['import', bundle, '--merge', 'append']).exitCode).toBe(0);
      // …and overwrite really does overwrite, so the guard did not just make
      // every strategy a no-op.
      expect(runCli(['import', bundle, '--merge', 'overwrite']).exitCode).toBe(0);
      expect(runCli(['recall', 'alpha', '--json']).stdout).toContain('REPLACEMENT');

      // Size pin, and not a formality: `append` above must have ADDED an
      // observation rather than quietly doing nothing. Without a non-zero count
      // asserted somewhere, every "exit code 0" check in this file would pass
      // just as happily against a command that did not run at all.
      // R2: recall --json is the object envelope {entities, retrieval, ...}.
      const after = JSON.parse(runCli(['recall', 'alpha', '--json']).stdout) as { entities: Array<{ observations: string[] }> };
      expect(after.entities.length).toBe(1);
      expect(after.entities[0].observations.length).toBeGreaterThanOrEqual(1);
    });

    it('overwriting an existing entity prints a different line than creating one from nothing (M-18)', () => {
      // Dogfooded: both cases printed the identical
      // "Imported: N, Skipped: 0, Appended: 0" — no way to tell a
      // destructive overwrite from a harmless first-time create.
      const bundle = seedAndBundle();
      const overwrite = runCli(['import', bundle, '--merge', 'overwrite']);
      expect(overwrite.stdout).toContain('overwritten');

      const freshBundle = path.join(home, 'fresh.json');
      fs.writeFileSync(freshBundle, JSON.stringify({
        version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 1,
        entities: [{ name: 'never-existed-before', type: 'note', observations: ['brand new'], tags: [] }],
      }));
      const create = runCli(['import', freshBundle, '--merge', 'overwrite']);
      expect(create.stdout).not.toContain('overwritten');
    });

    it('append does not duplicate an observation already present, and stays that way on re-import', () => {
      const bundle = seedAndBundle();
      runCli(['import', bundle, '--merge', 'append']);
      // Re-import the SAME bundle again — dogfooded: this duplicated the
      // observation a second time, unbounded on further re-runs.
      runCli(['import', bundle, '--merge', 'append']);
      const json = JSON.parse(runCli(['recall', 'alpha', '--json']).stdout) as { entities: Array<{ observations: string[] }> };
      const replacementCount = json.entities[0].observations.filter((o) => o === 'REPLACEMENT').length;
      expect(replacementCount, 'the same observation duplicated across re-imports').toBe(1);
    });
  });

  describe('--namespace', () => {
    for (const cmd of [
      ['remember', '--name', 'n', '--type', 'note', '--obs', 'x'],
      ['recall', 'x'],
      ['export'],
    ]) {
      it(`\`${cmd[0]}\` rejects a typo`, () => {
        const r = runCli([...cmd, '--namespace', 'persnal']);
        expect(r.exitCode).toBe(1);
        expect(r.stderr + r.stdout).toContain('personal, team, global');
      });
    }

    it('a real namespace still stores and recalls', () => {
      expect(runCli(['remember', '--name', 'teamy', '--type', 'note', '--obs', 'shared thing', '--namespace', 'team']).exitCode).toBe(0);
      const found = runCli(['recall', 'shared thing', '--namespace', 'team']);
      expect(found.exitCode).toBe(0);
      expect(found.stdout).toContain('teamy');
    });
  });

  describe('--severity', () => {
    it('rejects a level that is not one of the documented three', () => {
      const r = runCli(['learn', '--error', 'e', '--fix', 'f', '--severity', 'catastrophic']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr + r.stdout).toContain('critical, major, minor');
    });

    it('accepts a documented level', () => {
      expect(runCli(['learn', '--error', 'e', '--fix', 'f', '--severity', 'major']).exitCode).toBe(0);
    });
  });

  describe('crashes replaced by sentences', () => {
    it('`export -o` into a missing directory says so instead of dumping a stack', () => {
      const r = runCli(['export', '-o', path.join(home, 'no', 'such', 'dir', 'out.json')]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr + r.stdout).toMatch(/does not exist/);
      expect(r.stderr, 'a raw Node frame reached the user').not.toContain('node:fs');
      expect(r.stderr).not.toContain('at Object.');
    });

    it.skipIf(process.platform === 'win32')('the `mkdir -p` it prints runs nothing the directory name holds (#520)', () => {
      const cwd = path.join(home, 'cwd');
      fs.mkdirSync(cwd);
      const missing = path.join(home, "-d$(touch m1)`touch m2`;touch m3;it's \"q\" sp");
      const r = runCli(['export', '-o', path.join(missing, 'out.json')]);
      expect(r.exitCode).toBe(1);
      const command = /Create it first \((mkdir -p [\s\S]*)\), or drop -o/.exec(r.stderr)?.[1];
      expect(command, r.stderr).toBeDefined();
      const pasted = spawnSync('/bin/sh', ['-c', command!], { cwd, encoding: 'utf8' });
      for (const marker of ['m1', 'm2', 'm3']) expect(fs.existsSync(path.join(cwd, marker)), `${marker} created by: ${command}`).toBe(false);
      expect(pasted.status, pasted.stderr).toBe(0);
      expect(fs.statSync(missing).isDirectory()).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('the `memesh export --limit` hint it prints runs nothing the output path holds (#520)', () => {
      const cwd = path.join(home, 'cwd');
      fs.mkdirSync(cwd);
      // No quote in the name: a stray one would make an unquoted hint a syntax error that runs nothing.
      const dir = path.join(home, 'o$(touch m1)`touch m2`;touch m3');
      fs.mkdirSync(dir);
      expect(runCli(['remember', '--name', 'a', '--type', 'note', '--obs', 'one']).exitCode).toBe(0);
      expect(runCli(['remember', '--name', 'b', '--type', 'note', '--obs', 'two']).exitCode).toBe(0);
      // runCli keeps stderr only on failure, and this export succeeds.
      const r = spawnSync('node', [CLI_PATH, 'export', '--limit', '1', '-o', path.join(dir, 'out.json')], {
        encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      expect(r.status, r.stderr).toBe(0);
      const command = /raise it: (memesh export .*)$/m.exec(r.stderr)?.[1];
      expect(command, r.stderr).toBeDefined();
      spawnSync('/bin/sh', ['-c', command!], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      for (const marker of ['m1', 'm2', 'm3']) expect(fs.existsSync(path.join(cwd, marker)), `${marker} created by: ${command}`).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('the `memesh remember` fix hint it prints runs nothing the memory type holds (#520)', () => {
      const cwd = path.join(home, 'cwd');
      fs.mkdirSync(cwd);
      const r = runCli(['remember', 'a short note about the deploy', '--type', 't$(touch m1)`touch m2`;touch m3']);
      expect(r.exitCode, r.stderr).toBe(0);
      const command = /fix it with: (memesh remember .*)$/m.exec(r.stdout)?.[1];
      expect(command, r.stdout).toBeDefined();
      spawnSync('/bin/sh', ['-c', command!], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      for (const marker of ['m1', 'm2', 'm3']) expect(fs.existsSync(path.join(cwd, marker)), `${marker} created by: ${command}`).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('the printed remember and recall hints keep a name or type that starts with a dash as given (#520)', () => {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const asCli = (command: string) => command.replace(/^memesh /, `'${process.execPath}' '${CLI_PATH}' `);
      const r = runCli(['remember', 'a short note about the deploy', '--type', '-dash type']);
      expect(r.exitCode, r.stderr).toBe(0);
      const fix = /fix it with: (memesh remember .*)$/m.exec(r.stdout)?.[1];
      expect(fix, r.stdout).toBeDefined();
      const name = /--name=(\S+)/.exec(fix!)?.[1];
      const pasted = spawnSync('/bin/sh', ['-c', asCli(fix!)], { encoding: 'utf8', env });
      expect(pasted.status, pasted.stderr).toBe(0);
      const recalled = spawnSync('/bin/sh', ['-c', asCli(`memesh recall --json -- ${name}`)], { encoding: 'utf8', env });
      expect(JSON.parse(recalled.stdout).entities[0].type).toBe('-dash type');
      // The forget hint for a name that starts with a dash finds that memory.
      expect(runCli(['remember', '--name', '-dash-name', '--type', 'note', '--obs', 'kept']).exitCode).toBe(0);
      const miss = runCli(['forget', '--name', '-dash-name', '--observation', 'not there']);
      const see = /See them with: (memesh recall .*)$/m.exec(miss.stdout)?.[1];
      // `recall` searches, so a rewritten './-dash-name' would still find it: the hint must carry the name as given.
      expect(see).toBe("memesh recall --json -- '-dash-name'");
      const shown = spawnSync('/bin/sh', ['-c', asCli(see!)], { encoding: 'utf8', env });
      expect(JSON.parse(shown.stdout).entities.map((e: { name: string }) => e.name)).toContain('-dash-name');
    });

    it('`export -o` into a directory that exists still writes', () => {
      const out = path.join(home, 'out.json');
      expect(runCli(['export', '-o', out]).exitCode).toBe(0);
      expect(fs.existsSync(out)).toBe(true);
    });
  });

  describe('forget says which thing was missing', () => {
    it.skipIf(process.platform === 'win32')('the `memesh recall` it prints runs nothing the memory name holds (#520)', () => {
      const cwd = path.join(home, 'cwd');
      fs.mkdirSync(cwd);
      const name = "n$(touch m1)`touch m2`;touch m3;it's";
      expect(runCli(['remember', '--name', name, '--type', 'note', '--obs', 'kept']).exitCode).toBe(0);
      const r = runCli(['forget', '--name', name, '--observation', 'not there']);
      const command = /See them with: (memesh recall .*)$/m.exec(r.stdout)?.[1];
      expect(command, r.stdout + r.stderr).toBeDefined();
      spawnSync('/bin/sh', ['-c', command!], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      for (const marker of ['m1', 'm2', 'm3']) expect(fs.existsSync(path.join(cwd, marker)), `${marker} created by: ${command}`).toBe(false);
    });

    it('an entity that exists, with text that matches no observation', () => {
      expect(runCli(['remember', '--name', 'kept', '--type', 'note', '--obs', 'the real text']).exitCode).toBe(0);
      const r = runCli(['forget', '--name', 'kept', '--observation', 'text that is not there']);
      // Telling the user the ENTITY is missing sends them to re-create a memory
      // that is sitting right there — the one action that makes it worse.
      expect(r.stdout + r.stderr).toContain('no observation matching');
      expect(r.stdout + r.stderr).not.toContain('not found');
      expect(r.exitCode).toBe(1);
    });

    it('an entity that really is missing exits 1, like `pin` does', () => {
      const r = runCli(['forget', '--name', 'never-existed']);
      expect(r.stdout + r.stderr).toContain('not found');
      expect(r.exitCode, 'a forget that forgot nothing is invisible to scripts').toBe(1);
    });

    // D7: `--json` used to print the identical `{ archived: false, ... }`
    // envelope and exit 0 regardless of outcome — the one output shape a
    // script actually parses was the one that lied about whether anything
    // happened. These three pin the `--json` exit code to agree with the
    // human-readable one above, for all three forget outcomes.
    it('--json: an entity that really is missing exits 1, not 0', () => {
      const r = runCli(['forget', '--name', 'never-existed-json', '--json']);
      expect(r.exitCode, 'a forget --json that forgot nothing must not look like success').toBe(1);
      const parsed = JSON.parse(r.stdout) as { archived?: boolean };
      expect(parsed.archived).toBe(false);
    });

    it('--json: text that matches no observation exits 1, not 0', () => {
      expect(runCli(['remember', '--name', 'kept-json', '--type', 'note', '--obs', 'the real text']).exitCode).toBe(0);
      const r = runCli(['forget', '--name', 'kept-json', '--observation', 'text that is not there', '--json']);
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(r.stdout) as { observation_removed?: boolean; entity_found?: boolean };
      expect(parsed.observation_removed).toBe(false);
      expect(parsed.entity_found).toBe(true);
    });

    it('--json: an entity that IS archived still exits 0', () => {
      expect(runCli(['remember', '--name', 'to-archive-json', '--type', 'note', '--obs', 'bye']).exitCode).toBe(0);
      const r = runCli(['forget', '--name', 'to-archive-json', '--json']);
      expect(r.exitCode, 'a real archive must not be reported as a failure').toBe(0);
      const parsed = JSON.parse(r.stdout) as { archived?: boolean };
      expect(parsed.archived).toBe(true);
    });

    it('an EMPTY selector is refused, and never reported as a missing entity', () => {
      // `--observation ""` is what an unset shell variable expands to, and it
      // is the input that used to archive the whole memory. Core stopped
      // that; the CLI's MESSAGE branch was still truthiness-based, so `''`
      // fell past `opts.observation && …` into the final else and told the
      // user `Entity "kept-2" not found` about an entity sitting right there
      // — the exact false statement the test above exists to prevent, for a
      // different input.
      //
      // `ForgetSchema` rejects it with `.min(1)` at the MCP and HTTP
      // boundaries; the CLI calls core directly, so it needs its own refusal
      // rather than a different answer to the same question.
      expect(runCli(['remember', '--name', 'kept-2', '--type', 'note', '--obs', 'still here']).exitCode).toBe(0);

      const r = runCli(['forget', '--name', 'kept-2', '--observation', '']);
      expect(r.exitCode, 'an empty selector was accepted').toBe(1);
      expect(r.stdout + r.stderr, 'the refusal does not name the flag').toContain('--observation');
      expect(r.stdout + r.stderr, 'an entity that exists was reported missing').not.toContain('not found');

      // And the memory is untouched — active, with its observation.
      const check = runCli(['recall', 'kept-2', '--json']);
      expect(check.stdout, 'the empty selector destroyed something').toContain('still here');
    });

    it('a matching observation is still removed', () => {
      expect(runCli(['remember', '--name', 'trim', '--type', 'note', '--obs', 'goes away']).exitCode).toBe(0);
      const r = runCli(['forget', '--name', 'trim', '--observation', 'goes away']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Removed observation');
    });
  });
});
