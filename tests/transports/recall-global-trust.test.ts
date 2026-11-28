/**
 * Global is a storage scope, not a pass around trust: an untrusted global memory (a decision
 * from an imported bundle) does not appear in another project's default recall or briefing,
 * with or without a project tag. Searching for it on purpose (`cross_project`) finds it, and
 * its metadata says it is untrusted. A trusted global memory is shared as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { handleTool } from '../../src/mcp/tools.js';
import { assembleBriefing } from '../../src/core/briefing.js';

let dir: string;
let previousDir: string | undefined;
type Shown = { name: string; metadata?: { trust?: string } };

const recallFromA = async (args: Record<string, unknown>) => {
  const response = await handleTool('recall', args, undefined, undefined, { projectBinding: { project: 'proj-a' } });
  expect(response.isError, response.content[0].text).not.toBe(true);
  return JSON.parse(response.content[0].text).entities as Shown[];
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-global-trust-')));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ updateCheck: false }));
  openDatabase(path.join(dir, 'kg.db'));
  const kg = new KnowledgeGraph(getDatabase());
  const add = (name: string, tags: string[], trust: 'trusted' | 'untrusted') => {
    kg.createEntity(name, 'decision', { observations: [`quokka ${name}`, 'Why: it was chosen'], tags, namespace: 'global' });
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run(JSON.stringify({ trust, provenance: { source: trust === 'untrusted' ? 'import' : 'local' } }), name);
  };
  add('g-untrusted-b', ['project:proj-b'], 'untrusted');
  add('g-untrusted-none', [], 'untrusted');
  add('g-trusted-b', ['project:proj-b'], 'trusted');
  add('g-untrusted-own', ['project:proj-a'], 'untrusted');
});
afterEach(() => {
  closeDatabase();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('an untrusted global memory', () => {
  it('stays out of another project\'s default recall, with or without a project tag; the project\'s own stays in', async () => {
    const shown = (await recallFromA({ query: 'quokka' })).map(e => e.name).sort();
    expect(shown).toEqual(['g-trusted-b', 'g-untrusted-own']);
    const explicit = (await recallFromA({ query: 'quokka', project: 'proj-a' })).map(e => e.name).sort();
    expect(explicit).toEqual(['g-trusted-b', 'g-untrusted-own']);
  });

  it('is found when searched for on purpose, and says it is untrusted', async () => {
    const found = await recallFromA({ query: 'quokka', cross_project: true });
    expect(found.map(e => e.name).sort()).toEqual(['g-trusted-b', 'g-untrusted-b', 'g-untrusted-none', 'g-untrusted-own']);
    expect(found.find(e => e.name === 'g-untrusted-b')?.metadata?.trust).toBe('untrusted');
    expect(found.find(e => e.name === 'g-untrusted-none')?.metadata?.trust).toBe('untrusted');
  });

  it('is not in another project\'s briefing at any level', () => {
    const previous = process.env.MEMESH_BRIEFING;
    try {
      for (const level of ['minimal', 'standard', 'full']) {
        process.env.MEMESH_BRIEFING = level;
        const text = assembleBriefing('proj-c').text;
        expect(text, level).not.toContain('g-untrusted');
        expect(text, level).not.toMatch(/quokka g-untrusted/);
      }
    } finally {
      if (previous === undefined) delete process.env.MEMESH_BRIEFING;
      else process.env.MEMESH_BRIEFING = previous;
    }
  });
});
