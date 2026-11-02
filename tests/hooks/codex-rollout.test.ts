import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { createCodexState, finishCodex, readCodexRow } from '../../scripts/hooks/_codex-rollout.js';

const { redactSecrets } = createRequire(import.meta.url)('../../scripts/hooks/_shared.js');

const redact = (s: string) => s.replaceAll('invented-secret-value', '<redacted>');
const read = (rows: object[], redactWith: (s: string) => string = redact) => {
  const state = createCodexState();
  for (const row of rows) readCodexRow(row, state, redactWith);
  const sink = { filesEdited: new Set<string>(), bashCommands: [] as string[], errorsEncountered: [] as string[] };
  finishCodex(state, sink, redactWith);
  return sink;
};

const done = (item: object) => ({ type: 'event_msg', payload: { type: 'item_completed', item } });
const commandRow = (cmd: string, status: string, exit_code?: number, aggregated_output = '') =>
  done({ type: 'CommandExecution', command: ['sh', '-lc', cmd], status, ...(exit_code === undefined ? {} : { exit_code }), aggregated_output });
const failedRow = (output: string, exit_code = 1) => commandRow('npm run invented-check', 'failed', exit_code, output);
const execCall = (id: string, input = 'await tools.exec_command({ cmd: "invented-runner --default" })') =>
  ({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
const execOut = (id: string, ...texts: string[]) =>
  ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: texts.map(text => ({ type: 'input_text', text })) } });
// What a script prints for one command: the object exec_command returns (real shape).
const fnOut = () => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'fn1', output: 'invented agent reply' } });
const printed = (exit_code: number, output: string) =>
  JSON.stringify({ chunk_id: 'a1b2c3', wall_time_seconds: 0.1, exit_code, original_token_count: 3, output });

describe('Codex rollout reader', () => {
  it('redacts a command before it is cut to 100 characters', () => {
    const cmd = `${'x'.repeat(80)} TOKEN=invented-secret-value`;
    const { bashCommands } = read([commandRow(cmd, 'completed', 0)]);
    expect(bashCommands).toHaveLength(1);
    expect(bashCommands[0]).toContain('<redacted>');
    expect(bashCommands[0]).not.toContain('invented');
  });

  it('redacts a failed command\'s output before it is cut to 200 characters', () => {
    const { errorsEncountered } = read([failedRow(`${'y'.repeat(180)} token=invented-secret-value tail`, 2)]);
    expect(errorsEncountered).toHaveLength(1);
    expect(errorsEncountered[0]!.length).toBeLessThanOrEqual(200);
    expect(errorsEncountered[0]).toContain('<redacted>');
    expect(errorsEncountered[0]).not.toContain('invented');
  });

  it('an unknown result is not a success', () => {
    const { filesEdited } = read([
      commandRow("sed -i '' 's/a/b/' src/invented.ts", 'inProgress'),
      done({ type: 'CommandExecution', command: ['sh', '-lc', "sed -i '' 's/a/b/' src/invented2.ts"], status: 'completed' }),
    ]);
    expect([...filesEdited]).toEqual([]);
  });

  it('structured records win over the JS text of the same rollout', () => {
    const { filesEdited } = read([
      execCall('c1', 'const p = `*** Update File: src/invented-from-text.ts\n`;'),
      execOut('c1', 'Script completed'),
      done({ type: 'FileChange', changes: { '/repo/src/invented-from-record.ts': { type: 'update' } }, status: 'completed' }),
    ]);
    expect([...filesEdited]).toEqual(['invented-from-record.ts']);
  });

  it('a command that is not completed is not an edit even with exit 0, and is a failure', () => {
    const { filesEdited, errorsEncountered } = read([commandRow("sed -i '' 's/a/b/' src/invented.ts", 'failed', 0, 'invented stopped')]);
    expect([...filesEdited]).toEqual([]);
    expect(errorsEncountered).toEqual(['invented stopped']);
  });

  it('a failed command with no exit code is worded as such', () => {
    const { errorsEncountered } = read([commandRow('npm run invented', 'failed')]);
    expect(errorsEncountered).toEqual(['command failed']);
  });

  it('redacts the whole output before cutting, so a long secret cannot push another one past a cut', () => {
    // A long bearer value shrinks to a short marker when redacted; a second
    // token that began just before an earlier cut point must not survive as a
    // fragment too short for the rules to match.
    const token = 'gh' + 'p_' + 'a'.repeat(36);
    const output = `Authorization: Bearer ${'A'.repeat(965)} ${token} end`; // the token starts at about character 988, so a cut at 1000 would split it
    const { errorsEncountered } = read([failedRow(output, 22)], redactSecrets);
    expect(errorsEncountered).toHaveLength(1);
    expect(errorsEncountered[0]).not.toContain('gh' + 'p_');
    expect(errorsEncountered[0]).not.toContain('AAAAAAAA');
  });

  it('only the first few error texts are kept in full; the rest are still counted', () => {
    const { errorsEncountered } = read(Array.from({ length: 6 }, (_, i) => failedRow(`invented failure ${i}`, 2)));
    expect(errorsEncountered).toHaveLength(6);
    expect(errorsEncountered.slice(0, 3)).toEqual(['invented failure 0', 'invented failure 1', 'invented failure 2']);
    expect(errorsEncountered.slice(3)).toEqual(['error', 'error', 'error']);
  });

  describe('failures a script printed, matched to the failed command rows of that script', () => {
    // call -> rows completed while it runs -> its output
    const script = (id: string, rows: object[], ...texts: string[]) => [execCall(id), ...rows, execOut(id, 'Script completed', ...texts)];
    // One structured row anywhere makes the rollout structured.
    const structuredAnchor = () => commandRow('git status --short', 'completed', 0);

    it('a failed command row that was not printed plus a different printed failure with the same code is two', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [failedRow('invented-A')], printed(1, 'invented-B'))]);
      expect(errorsEncountered).toHaveLength(2);
    });

    it('the same with exit 127', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [failedRow('invented-A', 127)], printed(127, 'invented-B'))]);
      expect(errorsEncountered).toHaveLength(2);
    });

    const sameCmd = 'await tools.exec_command({ cmd: "npm run invented-check" })';

    it('a failed row from an agent tool call does not hide a later script\'s printed failure with the same code', () => {
      const { errorsEncountered } = read([structuredAnchor(), failedRow('invented-A', 127), fnOut(), execCall('a', sameCmd), execOut('a', 'Script completed', printed(127, 'invented-B'))]);
      expect(errorsEncountered).toHaveLength(2);
    });

    it('a failed row from an earlier turn does not hide a later printed failure', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [failedRow('invented-A')], printed(1, 'invented-A')), execCall('b', sameCmd), execOut('b', 'Script completed', printed(1, 'invented-B'))]);
      expect(errorsEncountered.sort()).toEqual(['invented-A', 'invented-B']);
    });

    it('a failure both recorded and printed is one', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [failedRow('invented-A')], printed(1, 'invented-A'))]);
      expect(errorsEncountered).toEqual(['invented-A']);
    });

    it('the same failure printed twice, in one script or in a later one, is one', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [], printed(1, 'invented-A'), printed(1, 'invented-A')), ...script('b', [], printed(1, 'invented-A'))]);
      expect(errorsEncountered).toEqual(['invented-A']);
    });

    it('a trimmed copy of a recorded failure\'s output is the same failure', () => {
      const full = `invented head\n${'z'.repeat(300)}\ninvented tail`;
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [failedRow(full)], printed(1, full.trim().slice(-120)))]);
      expect(errorsEncountered).toHaveLength(1);
      expect(errorsEncountered[0]).toBe(full.slice(0, 200));
    });

    it('a middle slice of a recorded failure\'s output is the same failure', () => {
      const full = `${'a'.repeat(120)}invented-middle${'b'.repeat(120)}`;
      expect(read([structuredAnchor(), ...script('a', [failedRow(full)], printed(1, 'invented-middle'))]).errorsEncountered).toHaveLength(1);
    });

    it('the same output with a different exit code is a different failure', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [failedRow('invented-A', 2)], printed(1, 'invented-A'))]);
      expect(errorsEncountered).toHaveLength(2);
    });

    it('a recorded failure whose script printed different text is the same failure when it ran the same command', () => {
      const same = [structuredAnchor(), execCall('a', 'await tools.exec_command({ cmd: "npm run invented-check" })'), failedRow('invented-A'), execOut('a', 'Script completed', printed(1, 'invented-different-text'))];
      expect(read(same).errorsEncountered).toEqual(['invented-A']);
    });

    it('a failed row without an exit code and the same failure printed is one', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [commandRow('npm run invented-check', 'failed', undefined, 'invented-A')], printed(1, 'invented-A'))]);
      expect(errorsEncountered).toEqual(['invented-A']);
    });

    it('two different printed failures and one failed row that matches one of them give both', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [failedRow('invented-A')], printed(1, 'invented-A'), printed(1, 'invented-B'))]);
      expect(errorsEncountered.sort()).toEqual(['invented-A', 'invented-B']);
      const two = read([structuredAnchor(), ...script('b', [failedRow('invented-C'), failedRow('invented-D')], printed(1, 'invented-C'), printed(1, 'invented-D'))]);
      expect(two.errorsEncountered.sort()).toEqual(['invented-C', 'invented-D']);
    });

    it('a long command\'s failure is not counted again when a later poll prints it, whatever ran in between', () => {
      const long = `${'q'.repeat(200)} invented long failure`;
      const unrelated = (id: string) => [{ type: 'response_item', payload: { type: 'function_call', call_id: id, name: 'wait_agent', arguments: '{}' } }, { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'invented agent reply' } }];
      const { errorsEncountered } = read([
        structuredAnchor(), failedRow(long), ...unrelated('f1'), ...unrelated('f2'),
        ...script('poll1', [], printed(1, long.slice(0, 150))),
        ...script('poll2', [], printed(1, long)),
      ]);
      expect(errorsEncountered).toHaveLength(1);
    });

    it('a failure printed before its command row was logged is one failure', () => {
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [], printed(1, 'invented-A')), failedRow('invented-A')]);
      expect(errorsEncountered).toEqual(['invented-A']);
    });

    it('one failed command row accounts for one printed failure, not every same-code failure in the script', () => {
      const withCmd = [structuredAnchor(), execCall('a', 'await tools.exec_command({ cmd: "npm run invented-check" })'), failedRow('invented-A'),
        execOut('a', 'Script completed', printed(1, 'invented-X'), printed(1, 'invented-Y'))];
      expect(read(withCmd).errorsEncountered).toHaveLength(2);
    });

    it('an empty output only matches a failed row of the same result window', () => {
      const { errorsEncountered } = read([structuredAnchor(), failedRow('', 1), ...script('a', [], printed(0, 'invented ok')), ...script('b', [], printed(1, ''))]);
      expect(errorsEncountered).toHaveLength(2);
    });

    it('two different failures that open alike are both reported', () => {
      const open = 'o'.repeat(90);
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [], printed(1, `${open} invented one`), printed(1, `${open} invented two`))]);
      expect(errorsEncountered).toHaveLength(2);
    });

    const pollCall = (id: string, session: number) =>
      execCall(id, `const r = await tools.write_stdin({ session_id: ${session}, chars: "", yield_time_ms: 1000 });\ntext(JSON.stringify(r));`);
    const failedWithPid = (output: string, process_id: string) =>
      done({ type: 'CommandExecution', command: ['sh', '-lc', 'npm run invented-long'], status: 'failed', exit_code: 1, aggregated_output: output, process_id });

    it('a poll of a running command that reprints its failure with no output is the same failure', () => {
      const rows = [structuredAnchor(), failedWithPid('invented-A', '4242'), fnOut(), pollCall('p', 4242), execOut('p', 'Script completed', printed(1, ''))];
      expect(read(rows).errorsEncountered).toEqual(['invented-A']);
    });

    it('a poll of a different process does not hide a failure', () => {
      const rows = [structuredAnchor(), failedWithPid('invented-A', '4242'), fnOut(), pollCall('p', 7777), execOut('p', 'Script completed', printed(1, ''))];
      expect(read(rows).errorsEncountered).toHaveLength(2);
    });

    it('a failure printed in an earlier window that shares only a header with a recorded one is still a separate failure', () => {
      const header = `${'h'.repeat(100)}`;
      const rows = [structuredAnchor(), failedRow(`${header} invented first`), fnOut(), ...script('a', [], printed(1, `${header} invented second`))];
      expect(read(rows).errorsEncountered).toHaveLength(2);
    });

    it('a later print that is only a part of an already claimed failure is a repeat', () => {
      const long = `${'a'.repeat(150)}${'b'.repeat(150)}`;
      const rows = [structuredAnchor(), failedRow(long), fnOut(), ...script('a', [], printed(1, long.slice(0, 150))), ...script('b', [], printed(1, long.slice(150)))];
      expect(read(rows).errorsEncountered).toHaveLength(1);
    });

    it('a poll with a claimed failure and another, different failure in the same script reports both', () => {
      const rows = [structuredAnchor(), failedWithPid('invented-A', '9'), fnOut(), pollCall('p', 9), execOut('p', 'Script completed', printed(1, ''), printed(1, 'invented-B'))];
      expect(read(rows).errorsEncountered.sort()).toEqual(['invented-A', 'invented-B']);
    });

    it('a session_id in a comment or another object is not a poll', () => {
      const code = '// session_id: 9\nconst r = await tools.exec_command({ cmd: "invented-other", session_id: 9 });';
      const rows = [structuredAnchor(), failedWithPid('invented-A', '9'), fnOut(), execCall('c', code), execOut('c', 'Script completed', printed(1, 'invented-B'))];
      expect(read(rows).errorsEncountered.sort()).toEqual(['invented-A', 'invented-B']);
    });

    it('a failure printed by a poll before its row was logged is one failure when the row names that process', () => {
      const rows = [structuredAnchor(), pollCall('p', 4242), execOut('p', 'Script completed', printed(1, '')), failedWithPid('invented-A', '4242')];
      expect(read(rows).errorsEncountered).toEqual(['invented-A']);
    });

    it('a very large JSON array does not make the reader drop the result inside it', () => {
      const big = JSON.stringify([...Array.from({ length: 300000 }, () => 0), JSON.parse(printed(1, 'invented-in-big-array'))]);
      expect(read([structuredAnchor(), ...script('a', [], big)]).errorsEncountered).toEqual(['invented-in-big-array']);
    });

    it('a result nested inside other JSON is still found', () => {
      const nested = JSON.stringify([{ status: 'ok', value: { chunk_id: 'a1', wall_time_seconds: 0.1, exit_code: 1, output: 'invented-nested' } }]);
      expect(read([structuredAnchor(), ...script('a', [], nested)]).errorsEncountered).toEqual(['invented-nested']);
    });

    it('a copy that differs at the start but ends the same is the same failure', () => {
      const common = 'z'.repeat(90);
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [failedRow(`invented head one ${common}`)], printed(1, `invented head two ${common}`))]);
      expect(errorsEncountered).toHaveLength(1);
    });

    it('a document with a marker field but no output is content, not a failure', () => {
      const doc = JSON.stringify({ chunk_id: 'invented-id', exit_code: 3 });
      expect(read([structuredAnchor(), ...script('a', [], doc)]).errorsEncountered).toEqual([]);
    });

    it('a JSON document with an exit_code field is content, not a failure', () => {
      const doc = JSON.stringify({ name: 'invented-package', exit_code: 3, output: 'invented' });
      const { errorsEncountered } = read([structuredAnchor(), ...script('a', [], doc)]);
      expect(errorsEncountered).toEqual([]);
    });

    it('a script that threw after a failed command is one error, not two', () => {
      const rows = [structuredAnchor(), execCall('a'), failedRow('invented-A'), execOut('a', 'Script failed', 'Script error: invented threw')];
      expect(read(rows).errorsEncountered).toEqual(['invented-A']);
      const printedToo = [structuredAnchor(), execCall('b'), execOut('b', 'Script failed', printed(1, 'invented-B'))];
      expect(read(printedToo).errorsEncountered).toEqual(['invented-B']);
    });
  });

  it('redacts a script error that has only a header line', () => {
    const { errorsEncountered } = read([execCall('a'), execOut('a', 'Script failed: token=invented-secret-value')]);
    expect(errorsEncountered).toHaveLength(1);
    expect(errorsEncountered[0]).not.toContain('invented');
  });

  describe('files under temporary folders', () => {
    const fileChange = (changes: Record<string, { type: string; move_path?: string }>) => done({ type: 'FileChange', changes, status: 'completed' });

    it('a recorded file change under /tmp, /private/tmp or /var/folders is not an edited file; a repo path still is', () => {
      const { filesEdited } = read([fileChange({
        '/tmp/invented-a.ts': { type: 'add' },
        '/private/tmp/invented-b.ts': { type: 'update' },
        '/var/folders/ab/cd/T/invented-c.ts': { type: 'add' },
        '/private/var/folders/ab/cd/T/invented-d.ts': { type: 'update' },
        '/repo/src/invented-real.ts': { type: 'update' },
      })]);
      expect([...filesEdited]).toEqual(['invented-real.ts']);
    });

    it('a move decides by where the file ends up', () => {
      const { filesEdited } = read([fileChange({
        '/repo/src/invented-to-tmp.ts': { type: 'update', move_path: '/tmp/invented-moved-away.ts' },
        '/tmp/invented-from-tmp.ts': { type: 'update', move_path: '/repo/src/invented-moved-in.ts' },
      })]);
      expect([...filesEdited]).toEqual(['invented-moved-in.ts']);
    });
  });

  describe('older rollouts (fallback)', () => {
    const patch = (name: string, verb = 'Update') => `const p = \`*** ${verb} File: src/${name}\n\`;`;

    it('only output that starts "Script completed" counts as success', () => {
      const { filesEdited } = read([
        execCall('a', patch('invented-done.ts')), execOut('a', 'Script completed\nWall time 1s'),
        execCall('b', patch('invented-running.ts')), execOut('b', 'Script running with cell ID invented'),
        execCall('c', patch('invented-failed.ts')), execOut('c', 'Script failed\nWall time 1s', 'Script error: invented'),
        execCall('d', patch('invented-string.ts')), { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'd', output: 'aborted before dispatch' } },
      ]);
      expect([...filesEdited]).toEqual(['invented-done.ts']);
    });

    it('a patch header under a temporary folder is not an edited file', () => {
      const { filesEdited } = read([
        execCall('a', patch('invented-rel.ts')), execOut('a', 'Script completed'),
        execCall('b', 'const p = `*** Add File: /private/tmp/invented-fb.ts\n+x\n*** Update File: /repo/src/invented-fb-real.ts\n`;'), execOut('b', 'Script completed'),
      ]);
      expect([...filesEdited].sort()).toEqual(['invented-fb-real.ts', 'invented-rel.ts']);
    });

    it('reads Add File headers and a quoted "cmd" key, and reports a failed exit code', () => {
      const { filesEdited, bashCommands, errorsEncountered } = read([
        execCall('a', patch('invented-added.ts', 'Add')), execOut('a', 'Script completed'),
        execCall('b', `await tools.exec_command({ "cmd": "tee src/invented-quoted.ts < invented-input" })`), execOut('b', 'Script completed', printed(0, '')),
        execCall('c'), execOut('c', 'Script completed', printed(3, 'invented-check: boom')),
      ]);
      expect([...filesEdited].sort()).toEqual(['invented-added.ts', 'invented-quoted.ts']);
      expect(bashCommands).toHaveLength(2);
      expect(errorsEncountered).toEqual(['invented-check: boom']);
    });

    it('redacts, then cuts: a command at 100, command output and a script error at 200', () => {
      const secret = 'invented-secret-value';
      const longCmd = `${'x'.repeat(88)} TOKEN=${secret}`;
      const { bashCommands, errorsEncountered } = read([
        execCall('a', `await tools.exec_command({ cmd: ${JSON.stringify(longCmd)} })`),
        execOut('a', 'Script completed', printed(1, `${'y'.repeat(180)} token=${secret} tail`)),
        execCall('b', 'await tools.exec_command({ cmd: "echo ok" })'),
        execOut('b', 'Script failed', `${'z'.repeat(180)} token=${secret} tail`),
      ]);
      expect(bashCommands).toHaveLength(1);
      expect(bashCommands[0]!.length).toBeLessThanOrEqual(100);
      expect(bashCommands[0]).not.toContain('invented');
      expect(errorsEncountered).toHaveLength(2);
      for (const e of errorsEncountered) {
        expect(e.length).toBeLessThanOrEqual(200);
        expect(e).not.toContain('invented');
      }
    });

    it('redacts a failed file change\'s error text before cutting it', () => {
      const { errorsEncountered } = read([
        done({ type: 'FileChange', changes: {}, status: 'failed', stderr: `${'e'.repeat(180)} token=invented-secret-value tail` }),
      ]);
      expect(errorsEncountered).toHaveLength(1);
      expect(errorsEncountered[0]!.length).toBeLessThanOrEqual(200);
      expect(errorsEncountered[0]).not.toContain('invented');
    });
  });
});
