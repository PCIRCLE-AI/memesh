/**
 * The SessionStart hook is the surface most agents see. A decision's line there
 * must carry its reason, say when it has none, and ask for a re-check after
 * 30 days nobody read or added to it, in the ranked block and in the durable
 * memory index, the same as `briefing` prints it.
 *
 * Runs scripts/hooks/session-start.js itself (its generated copy of the
 * briefing code) in a throwaway HOME, against a database seeded through core.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const { getProjectName: mirrorProjectName } = require('../../scripts/hooks/_shared.js');
const hookPath = path.resolve('scripts/hooks/session-start.js');

let root: string;
let dbPath: string;
let dir: string;
let previousLevel: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-session-start-why-')));
  dbPath = path.join(root, 'memesh', 'knowledge-graph.db');
  dir = path.join(root, 'proj');
  fs.mkdirSync(dir);
  // The default level ("minimal") leaves the index out; this test reads both.
  previousLevel = process.env.MEMESH_BRIEFING;
  process.env.MEMESH_BRIEFING = 'standard';
});
afterEach(() => {
  if (previousLevel === undefined) delete process.env.MEMESH_BRIEFING; else process.env.MEMESH_BRIEFING = previousLevel;
  try { closeDatabase(); } catch { /* not open */ }
  removeTempDir(root);
});

function runHook(): string {
  const out = execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify({ cwd: dir }),
    env: { PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_UPDATE: '0', MEMESH_BRIEFING: 'standard' },
    encoding: 'utf8',
    timeout: 15000,
  });
  return (JSON.parse(out.trim()) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
}

const decisionLines = (text: string): string[] => text.split('\n').filter((l) => /^- \[(decision|architecture_decision)\]/.test(l));

describe('SessionStart: a decision is shown with its reason and its age', () => {
  it('the ranked block and the index carry the reason, the missing reason and the age note, as `briefing` does', () => {
    const project = mirrorProjectName(dir);
    openDatabase(dbPath);
    remember({ name: 'fresh-choice', type: 'decision', title: 'Keep the cache layer', observations: ['Keep the cache layer'], why: 'the API is rate limited; revisit if the vendor lifts the limit', project });
    new KnowledgeGraph(getDatabase()).createEntity('bare-choice', 'decision', { observations: ['Use tabs'], tags: [`project:${project}`], trustOverride: 'trusted', title: 'Use tabs' });
    // An architecture_decision is not in the decision layer: its age comes from its observations.
    remember({ name: 'old-choice', type: 'architecture_decision', title: 'Queue it', observations: ['Queue it'], why: 'buffers bursts; revisit if flat', project });
    getDatabase().prepare("UPDATE observations SET created_at = datetime('now', '-40 days') WHERE entity_id = (SELECT id FROM entities WHERE name = 'old-choice')").run();
    getDatabase().prepare("UPDATE entities SET created_at = datetime('now', '-40 days'), last_accessed_at = NULL WHERE name = 'old-choice'").run();
    const briefing = assembleBriefing(project).text;
    closeDatabase();

    const context = runHook();
    const [ranked, index] = context.split('Index of durable memories for');
    expect(index, 'the hook printed no index').toBeTruthy();
    for (const part of [ranked, index]) {
      expect(part).toMatch(/- \[decision\] Keep the cache layer — Why: the API is rate limited; revisit if the vendor lifts the limit \[mem:\d+\]/);
      expect(part).toMatch(/- \[decision\] Use tabs \(no reason recorded\) \[mem:\d+\]/);
      expect(part).toMatch(/- \[architecture_decision\] Queue it — Why: buffers bursts; revisit if flat \(unconfirmed 40 days: re-check before relying\) \[mem:\d+\]/);
    }
    // The same lines, in the same order, as the briefing prints.
    expect(decisionLines(context)).toHaveLength(6);
    expect(decisionLines(context)).toEqual(decisionLines(briefing));
  });
});
