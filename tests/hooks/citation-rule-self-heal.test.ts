/** SessionStart must not create or rewrite Claude rule files. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CITATION_RULE_BODY } from '../../src/core/citation-rule.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start.js');
const RULE = 'memesh-citations.md';

let home: string;
let project: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-session-start-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-session-start-project-'));
  fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
});

afterEach(() => {
  removeTempDir(home, project);
});

function runHook(envOverride: NodeJS.ProcessEnv = {}): number {
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const payload = JSON.stringify({
    session_id: 's1',
    transcript_path: transcript,
    cwd: project,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  try {
    execFileSync('node', [HOOK], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: project, ...envOverride },
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

function writeMarker(scope: 'user' | 'project' | 'corrupt'): void {
  const marker = path.join(home, '.memesh', 'install-hooks.json');
  if (scope === 'corrupt') {
    fs.writeFileSync(marker, '{ not json');
    return;
  }
  fs.writeFileSync(marker, JSON.stringify({ scope }));
}

const ruleAt = (root: string) => path.join(root, 'rules', RULE);

describe('SessionStart leaves Claude rules alone', () => {
  it.each(['missing', 'user', 'project', 'corrupt'] as const)('does not create rules with a %s install marker', (marker) => {
    const config = path.join(home, 'claude-config');
    if (marker !== 'missing') writeMarker(marker);

    expect(runHook({ CLAUDE_CONFIG_DIR: config })).toBe(0);
    for (const rule of [ruleAt(config), ruleAt(path.join(home, '.claude')), ruleAt(path.join(project, '.claude'))]) {
      expect(fs.existsSync(rule), rule).toBe(false);
    }
  });

  it.each([
    ['current', CITATION_RULE_BODY],
    ['stale', '<!-- managed-by: memesh -->\n# stale\n'],
  ])('leaves a %s MeMesh rule byte-for-byte unchanged', (_kind, existing) => {
    const config = path.join(home, 'claude-config');
    const rule = ruleAt(config);
    fs.mkdirSync(path.dirname(rule), { recursive: true });
    fs.writeFileSync(rule, existing);

    expect(runHook({ CLAUDE_CONFIG_DIR: config })).toBe(0);
    expect(fs.readFileSync(rule, 'utf8')).toBe(existing);
  });

  it('leaves a foreign Claude rule byte-for-byte unchanged', () => {
    const config = path.join(home, 'claude-config');
    const rule = path.join(config, 'rules', RULE);
    const theirs = '# my own rules\nnever run rm -rf\n';
    fs.mkdirSync(path.dirname(rule), { recursive: true });
    fs.writeFileSync(rule, theirs);

    expect(runHook({ CLAUDE_CONFIG_DIR: config })).toBe(0);
    expect(fs.readFileSync(rule, 'utf8')).toBe(theirs);
  });
});
