/**
 * #540: the getting-started steps (remember, recall, briefing) show the memory
 * that was just stored — with and without a project tag — on a brand-new
 * install. Runs the built CLI against a throwaway HOME.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';

const dirs: string[] = [];
afterEach(() => { removeTempDir(...dirs.splice(0)); });

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-getting-started-'));
  dirs.push(home);
  const project = path.join(home, 'proj');
  fs.mkdirSync(project);
  spawnSync('git', ['init', '-q', '.'], { cwd: project });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/example/proj.git'], { cwd: project });
  const cli = (...args: string[]) => {
    const r = spawnSync('node', [path.resolve('dist/transports/cli/cli.js'), ...args], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, MEMESH_DIR: undefined, MEMESH_DB_PATH: undefined, MEMESH_BRIEFING: undefined },
      timeout: 30_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { cli };
}

describe('#540: getting started shows what was stored', () => {
  it('a plain note from the README example appears in recall and in briefing', () => {
    const { cli } = sandbox();
    expect(cli('remember', '--name', 'test', '--type', 'note', '--obs', 'Hello World').status).toBe(0);
    expect(cli('recall', 'test').out).toContain('Hello World');
    const briefing = cli('briefing');
    expect(briefing.status).toBe(0);
    expect(briefing.out.length).toBeGreaterThan(0);
    expect(briefing.out).toContain('Hello World');
    expect(briefing.out).not.toContain('Nothing to brief');
  });

  it('a plain note tagged with this project (what an agent stores) appears in briefing', () => {
    const { cli } = sandbox();
    const project = (JSON.parse(cli('briefing', '--json').out) as { project: string }).project;
    expect(cli('remember', 'This project uses SQLite', '--tags', `project:${project}`).status).toBe(0);
    const briefing = cli('briefing');
    expect(briefing.out).toContain('This project uses SQLite');
    expect(briefing.out).not.toContain('Nothing to brief');
  });
});
