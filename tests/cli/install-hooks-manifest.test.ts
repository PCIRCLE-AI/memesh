/**
 * memesh's own hooks file (`hooks/hooks.json`) is what an install writes into the user's settings. When it
 * is damaged, the install must say so in one plain sentence and change nothing, and above all must not read
 * "no hooks" as "memesh retired every hook" and delete the ten the user already has (#528, second round).
 *
 * The real built CLI runs from a copy of the package whose hooks file the test can damage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeMachine, type Machine } from '../helpers/cli-machine.js';

const machines: Machine[] = [];
afterEach(() => { for (const m of machines.splice(0)) m.cleanup(); });

/** A copy of the package with only what the CLI needs to find its own hooks file. */
function packageCopy(m: Machine): { cliPath: string; manifestPath: string } {
  const root = path.join(m.root, 'pkg');
  fs.mkdirSync(path.join(root, 'dist', 'transports', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.copyFileSync('package.json', path.join(root, 'package.json'));
  fs.copyFileSync('dist/transports/cli/cli.js', path.join(root, 'dist', 'transports', 'cli', 'cli.js'));
  fs.copyFileSync('hooks/hooks.json', path.join(root, 'hooks', 'hooks.json'));
  return { cliPath: path.join(root, 'dist', 'transports', 'cli', 'cli.js'), manifestPath: path.join(root, 'hooks', 'hooks.json') };
}

describe.skipIf(process.platform === 'win32')("memesh's own hooks file is damaged (#528)", () => {
  it.each([
    '{"hooks":[]}',
    '{"hooks":{}}',
    '{"hooks":{"Stop":{}}}',
    '[{"hooks":null}]',
    '{"hooks":{"Stop":[{"hooks":[{"type":"command"}]}]}}',
  ])('%s: install refuses in one plain sentence and the hooks already installed stay', (body) => {
    const m = makeMachine({ MEMESH_SKIP_POST_INSTALL_JOURNEY: '1' });
    machines.push(m);
    const { cliPath, manifestPath } = packageCopy(m);
    const good = m.run(['install-hooks'], {}, cliPath);
    expect(good.status, `fixture: the first install failed: ${good.text}`).toBe(0);
    const settingsPath = path.join(m.home, '.claude', 'settings.json');
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain('_memesh');
    fs.writeFileSync(manifestPath, body);

    const { result, changed } = m.runAndDiff(['install-hooks'], {}, cliPath);
    expect(result.status, result.text).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain(`install-hooks failed: memesh's own hooks file at ${manifestPath} is damaged`);
    expect(result.stderr).toContain('nothing was changed');
    expect(result.text, 'a raw TypeError reached the person').not.toMatch(/Cannot read|is not a function|TypeError/);
    expect(result.stdout, 'a success message was printed').not.toContain('retired memesh hook');
    expect(changed, changed.join('\n')).toEqual([]);
  });
});
