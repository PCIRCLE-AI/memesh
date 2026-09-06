/** Human review of existing guard proposals remains deterministic and model-free. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


function guardResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: 'GUARD',
    guard: {
      tool: 'Bash',
      pattern: 'git\\s+checkout\\s+--\\s',
      message: 'git checkout -- discards uncommitted work. Commit or stash first.',
      should_match: ['git checkout -- src/', 'git checkout -- .'],
      should_not_match: ['git checkout -b feature', 'git status'],
      ...overrides,
    },
  });
}

describe('lesson guards (dreamer side)', () => {
  let tmpHome: string;
  let db: any;
  let kg: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-guards-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    process.env.MEMESH_DIR = tmpHome;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    kg = new KnowledgeGraph(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    delete process.env.MEMESH_DIR;
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedFailureLesson(name = 'checkout-lesson'): number {
    return kg.createEntity(name, 'lesson_learned', {
      observations: [
        'Error: git checkout -- wiped five files of uncommitted fixes',
        'Root cause: restore ran before the fix was committed',
        'Fix: commit first, then mutate, then restore',
        'Prevention: never run git checkout -- with a dirty tree',
      ],
      tags: ['project:memesh'],
    });
  }

  function stageGuard(lessonId: number): void {
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version, kind)
      VALUES ('memesh', ?, ?, ?, 'guard-v1', 'guard')
    `).run('guard:' + lessonId, JSON.stringify([lessonId]), JSON.stringify({
      guard: JSON.parse(guardResponse()).guard,
      source_lesson: { id: lessonId, name: 'checkout-lesson' },
    }));
  }

  it('accepting writes metadata.guard onto the source lesson — warn-only, evidence attached', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const lessonId = seedFailureLesson();
    stageGuard(lessonId);
    const proposalId = db.prepare("SELECT id FROM dream_proposals WHERE kind = 'guard'").get().id;

    const applied = applyProposal(db, proposalId, kg);
    expect(applied.kind).toBe('guard');
    expect(applied.sourcesArchived).toBe(0);
    expect(applied.digestEntityName).toContain('checkout-lesson');

    const meta = JSON.parse(db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId).metadata);
    expect(meta.guard.enabled).toBe(true);
    // v1 policy: acceptance never escalates past warn, whatever the model said.
    expect(meta.guard.action).toBe('warn');
    expect(meta.guard.fires).toBe(0);
    expect(meta.guard.should_match.length).toBeGreaterThanOrEqual(2);
    expect(db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(proposalId).status).toBe('applied');

    // The lesson itself is untouched otherwise: still active, no archive.
    expect(db.prepare('SELECT status FROM entities WHERE id = ?').get(lessonId).status).toBe('active');
  });

  it('acceptance re-verifies with no model: a spec that stopped being valid throws', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const lessonId = seedFailureLesson();
    // Hand-stage a proposal whose pattern is too broad — as if validation
    // rules tightened between staging and review months later.
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version, kind)
      VALUES ('memesh', 'guard:${lessonId}', ?, ?, 'test/fake', 'guard-v1', 'guard')
    `).run(JSON.stringify([lessonId]), JSON.stringify({
      guard: { tool: 'Bash', pattern: '.*', message: 'anything', should_match: ['a b c d e f'], should_not_match: [] },
      source_lesson: { id: lessonId, name: 'checkout-lesson' },
    }));
    const proposalId = db.prepare("SELECT id FROM dream_proposals WHERE kind = 'guard'").get().id;

    expect(() => applyProposal(db, proposalId, kg)).toThrow(/guard spec is not valid/);
    // Nothing landed on the lesson.
    const metaRaw = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId).metadata;
    expect(metaRaw === null || !JSON.parse(metaRaw).guard).toBe(true);
  });

  it('accepting a guard for an archived lesson fails loudly', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const lessonId = seedFailureLesson();
    stageGuard(lessonId);
    const proposalId = db.prepare("SELECT id FROM dream_proposals WHERE kind = 'guard'").get().id;

    db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(lessonId);
    expect(() => applyProposal(db, proposalId, kg)).toThrow(/no longer active/);
  });
});
