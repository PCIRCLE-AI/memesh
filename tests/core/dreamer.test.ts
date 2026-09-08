// Agent work-package proposal staging and human review.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('dreamer', () => {
  let tmpHome: string;
  let db: any;
  let kg: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-dreamer-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    process.env.MEMESH_DIR = tmpHome;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    kg = new KnowledgeGraph(db);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    delete process.env.MEMESH_DIR;
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedCommits(count: number, project = 'memesh'): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const name = `Commit abc${i}: feat: add thing ${i}`;
      const id = kg.createEntity(name, 'commit', {
        observations: [`feat: add thing ${i}\n\nDetails about change ${i} that justify a body`],
        tags: [`project:${project}`],
      });
      ids.push(id);
    }
    return ids;
  }

  it('listProposals returns empty when no proposals exist', async () => {
    const { listProposals } = await import('../../src/core/dreamer.js');
    expect(listProposals(db, 'pending')).toEqual([]);
  });

  it('apply: a digest whose name collides never merges into the memory already there', async () => {
    // `createEntity` uses INSERT OR IGNORE, so a taken name meant the insert
    // was SKIPPED: none of the digest metadata was written, the submitted
    // observations appended to the user's own memory, and this transaction
    // went on to archive the sources under it — reporting success. The
    // extraction prompt asks for short slug names, which is exactly the shape
    // that collides. `applyTranscriptProposal` has carried this guard, with
    // this reasoning, the whole time; the digest path did not.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(5);

    // A memory the USER wrote, under a name an agent might well choose.
    kg.createEntity('auth-decisions', 'decision', {
      observations: ['we chose OAuth 2.0 with PKCE'],
    });
    const before = kg.getEntity('auth-decisions');
    expect(before?.observations, 'fixture: the user memory was not created').toHaveLength(1);

    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('memesh', '2026-W19', ?, ?, 'v1')
    `).run(JSON.stringify(sourceIds), JSON.stringify({
      name: 'auth-decisions', type: 'digest',
      observations: ['an agent-written summary of five commits'], tags: ['digest'],
    }));
    const proposalId = (db.prepare(
      "SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC",
    ).get() as { id: number }).id;

    const result = applyProposal(db, proposalId, kg);

    // The user's memory is exactly as it was.
    const after = kg.getEntity('auth-decisions');
    expect(after?.observations, "the digest's text merged into the user's memory").toHaveLength(1);
    expect(after?.observations[0]).toBe('we chose OAuth 2.0 with PKCE');
    expect(after?.type, 'the user memory changed type').toBe('decision');

    // The digest landed somewhere of its own, and the caller was told where.
    expect(result.digestEntityName, 'the reported name is the colliding one')
      .not.toBe('auth-decisions');
    const digest = kg.getEntity(result.digestEntityName);
    expect(digest, 'the digest was not created at all').toBeTruthy();
    expect(digest?.observations).toEqual(['an agent-written summary of five commits']);
    expect(digest?.metadata?.proposal_id, 'the digest metadata was never written').toBe(proposalId);
  });

  it('apply: a digest with a free name keeps it — the anti-vacuity half', async () => {
    // A guard that always suffixed would satisfy the test above while making
    // every digest name unrecognisable.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(5);
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('memesh', '2026-W20', ?, ?, 'v1')
    `).run(JSON.stringify(sourceIds), JSON.stringify({
      name: 'a-free-name', type: 'digest', observations: ['a summary'], tags: ['digest'],
    }));
    const proposalId = (db.prepare(
      "SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC",
    ).get() as { id: number }).id;

    expect(applyProposal(db, proposalId, kg).digestEntityName).toBe('a-free-name');
  });

  it('apply: refuses a source another digest already compacted, and says so', async () => {
    // `metadata.compacted_into` is a single value, so a source belongs to one
    // digest only. Accepting two overlapping proposals used to overwrite it
    // silently: one digest held the back-pointer while the other still claimed
    // the source through its `summarizes` edge, with nothing in the row saying
    // which was right. Proposing such a pair is refused upstream now, but a
    // graph can already hold one from before that.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(6);
    const stage = (name: string, ids: number[]) => {
      db.prepare(`
        INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
        VALUES ('memesh', '2026-W19', ?, ?, 'v1')
      `).run(JSON.stringify(ids), JSON.stringify({
        name, type: 'digest', observations: ['a consolidated summary of the work'], tags: ['digest'],
      }));
      return (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;
    };
    const firstId = stage('digest-first', sourceIds.slice(0, 4));
    const secondId = stage('digest-second', sourceIds); // overlaps the first

    expect(applyProposal(db, firstId, kg).sourcesArchived).toBe(4);

    const second = applyProposal(db, secondId, kg);
    expect(second.sourcesArchived, 'the second digest took sources the first owned').toBe(2);
    expect(second.sourcesAlreadyCompacted, 'the refusal was silent').toBe(4);

    // The digest must claim only what it took — the dashboard reads this field.
    const digest = db.prepare("SELECT metadata FROM entities WHERE name = 'digest-second'").get() as { metadata: string };
    const meta = JSON.parse(digest.metadata);
    expect(meta.source_ids, 'the digest claims sources it never archived').toEqual(sourceIds.slice(4));
    expect(meta.sources_refused).toEqual(sourceIds.slice(0, 4));

    // And each source still points at exactly one digest.
    for (const id of sourceIds.slice(0, 4)) {
      const row = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(id) as { metadata: string };
      expect(JSON.parse(row.metadata).compacted_into).toBe(
        (db.prepare("SELECT id FROM entities WHERE name = 'digest-first'").get() as { id: number }).id
      );
    }
  });

  /** Rows the keyword index holds for an entity id — same query as
   *  tests/core/archived-index-hygiene.test.ts, since it targets the same
   *  contentless FTS5 table and its rowid-is-the-unit reasoning applies here
   *  identically. */
  function ftsRowCount(id: number): number {
    return (
      db.prepare('SELECT COUNT(*) AS c FROM entities_fts WHERE rowid = ?').get(id) as { c: number }
    ).c;
  }

  it('apply: compaction takes its sources out of the keyword index, and leaves the digest in them', async () => {
    // Independent review of PR #292 (F2): none of that PR's break-tests cover
    // this call — `dropEntityFromIndexes(db, sourceId, sourceRow.name)` inside
    // the compaction branch of `applyProposal` (src/core/dreamer.ts). Deleting
    // the call, or passing it the digest's own id/name instead of the
    // source's, left the whole suite green. This test fails on both mutations
    // (verified locally by reverting the call and by swapping its arguments
    // for the digest's own id/name, then re-running this test — both went
    // red; restored afterward).
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(5);

    for (const id of sourceIds) expect(ftsRowCount(id), 'fixture: source not indexed').toBe(1);

    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('memesh', '2026-W21', ?, ?, 'v1')
    `).run(JSON.stringify(sourceIds), JSON.stringify({
      name: 'digest-index-hygiene', type: 'digest',
      observations: ['a consolidated summary of five commits'], tags: ['digest'],
    }));
    const proposalId = (db.prepare(
      "SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC",
    ).get() as { id: number }).id;

    const result = applyProposal(db, proposalId, kg);
    expect(result.sourcesArchived).toBe(5);

    // Every compacted source is out of the keyword index.
    for (const id of sourceIds) {
      expect(ftsRowCount(id), `source ${id} still has an FTS row after compaction`).toBe(0);
    }

    // The digest itself — the thing that took the sources' place — is still
    // in the keyword index. A mutation that dropped the DIGEST's own row
    // instead of the sources' would pass every assertion above and fail only
    // this one.
    const digest = db.prepare('SELECT id FROM entities WHERE name = ?').get(result.digestEntityName) as
      | { id: number }
      | undefined;
    expect(digest, 'the digest entity was not created').toBeTruthy();
    expect(ftsRowCount(digest!.id), "the digest's own FTS row was removed instead of the sources'").toBe(1);
  });

  it('apply: refuses a digest that would claim NONE of its sources, and writes nothing', async () => {
    // The partial-overlap case above returns a digest holding what it took. Take
    // that to its limit — every source already compacted — and the old code
    // still applied it: `taken` empty, an entity created before the loop and
    // left behind summarising nothing, zero `summarizes` edges, and the proposal
    // marked `applied` with `sourcesArchived: 0` reported as success.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(4);
    const stage = (name: string) => {
      db.prepare(`
        INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
        VALUES ('memesh', '2026-W19', ?, ?, 'v1')
      `).run(JSON.stringify(sourceIds), JSON.stringify({
        name, type: 'digest', observations: ['a consolidated summary of the work'], tags: ['digest'],
      }));
      return (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;
    };
    const firstId = stage('digest-owner');
    const secondId = stage('digest-empty-handed'); // identical source set

    expect(applyProposal(db, firstId, kg).sourcesArchived).toBe(4);

    expect(() => applyProposal(db, secondId, kg)).toThrow(/claimed nothing/);

    // Rolled back: the entity must not exist. This is the assertion that fails
    // if the refusal is moved after `createEntity` instead of throwing.
    expect(
      db.prepare("SELECT id FROM entities WHERE name = 'digest-empty-handed'").get(),
      'a digest that claimed nothing was still written to the graph'
    ).toBeUndefined();

    // …and it must not stay pending, or every later review keeps retrying an
    // application that can never succeed.
    const after = db.prepare('SELECT status, reason FROM dream_proposals WHERE id = ?').get(secondId) as { status: string; reason: string | null };
    expect(after.status, 'a proposal that can never apply was left pending').toBe('rejected');
    expect(after.reason).toMatch(/already summarised/);

    // The first digest keeps every source: the refusal took nothing away.
    for (const id of sourceIds) {
      const row = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(id) as { metadata: string };
      expect(JSON.parse(row.metadata).compacted_into).toBe(
        (db.prepare("SELECT id FROM entities WHERE name = 'digest-owner'").get() as { id: number }).id
      );
    }
  });

  it('apply: does NOT claim a proposal was rejected when the rejection write failed', async () => {
    // The catch around `rejectProposal` may swallow exactly one failure — "not
    // found or not pending", something else settled the row. A bare catch also
    // swallowed SQLITE_BUSY and disk-full, and then let an error escape whose
    // text promised the proposal would not be retried — while it sat there
    // pending and retried by every later review.
    //
    // The write failure is injected with a trigger because nothing in a
    // single-process suite can make this UPDATE fail for real: the abort fires
    // only on a transition to 'rejected', so the apply path's own writes are
    // untouched.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(3);
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('memesh', '2026-W19', ?, ?, 'v1')
    `).run(JSON.stringify(sourceIds), JSON.stringify({
      name: 'digest-unrejectable', type: 'digest', observations: ['a summary'], tags: ['digest'],
    }));
    const proposalId = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;
    for (const id of sourceIds) db.prepare('DELETE FROM entities WHERE id = ?').run(id);

    db.exec(`
      CREATE TRIGGER reject_write_fails BEFORE UPDATE ON dream_proposals
      WHEN NEW.status = 'rejected'
      BEGIN SELECT RAISE(ABORT, 'simulated disk I/O error'); END
    `);
    try {
      let thrown: Error | undefined;
      try { applyProposal(db, proposalId, kg); } catch (e) { thrown = e as Error; }
      expect(thrown, 'applyProposal swallowed a failed rejection entirely').toBeDefined();
      expect(
        thrown!.message,
        'the error still promised the proposal would not be retried'
      ).toMatch(/still pending/);
      expect(thrown!.message).not.toMatch(/will not be retried/);
      // And the row really is still pending — the message must match the state.
      const row = db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(proposalId) as { status: string };
      expect(row.status).toBe('pending');
    } finally {
      db.exec('DROP TRIGGER reject_write_fails');
    }
  });

  it('apply: a digest whose sources were FORGOTTEN says so, not "already summarised"', async () => {
    // The digest branch has its own `if (!sourceRow) continue`, so its
    // empty-claim case has two distinct causes — and the rejection reason is
    // operator-facing (`dream list`, dashboard). The first version keyed the
    // reason on the branch alone, so a compaction whose sources were all
    // deleted blamed "another digest" that never existed, and the operator
    // audited for a duplicate instead of the forget that actually happened.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(3);
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('memesh', '2026-W19', ?, ?, 'v1')
    `).run(JSON.stringify(sourceIds), JSON.stringify({
      name: 'digest-of-the-forgotten', type: 'digest', observations: ['a summary'], tags: ['digest'],
    }));
    const proposalId = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;

    for (const id of sourceIds) db.prepare('DELETE FROM entities WHERE id = ?').run(id);

    expect(() => applyProposal(db, proposalId, kg)).toThrow(/claimed nothing/);
    const after = db.prepare('SELECT status, reason FROM dream_proposals WHERE id = ?').get(proposalId) as { status: string; reason: string | null };
    expect(after.status).toBe('rejected');
    expect(after.reason, 'a deleted-sources digest blamed a nonexistent duplicate digest').toMatch(/no longer exist|still exist/);
    expect(after.reason).not.toMatch(/another digest/);
  });

  it('apply: a MIXED empty claim names both causes, with the right count for each', async () => {
    // The two tests above stage one cause each, and both stayed green when the
    // `missingSources` counter was deleted — because with the counter at zero
    // the reason falls into the "all of them were already summarised" branch,
    // which is exactly what the all-compacted test asserts. A break-test caught
    // that: the fix that added the counter had no test that could fail without
    // it. This is that test — some sources compacted, some forgotten, which is
    // the ordinary shape once a graph has been running a while.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(4);
    const stage = (name: string, ids: number[]) => {
      db.prepare(`
        INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
        VALUES ('memesh', '2026-W19', ?, ?, 'v1')
      `).run(JSON.stringify(ids), JSON.stringify({
        name, type: 'digest', observations: ['a consolidated summary of the work'], tags: ['digest'],
      }));
      return (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;
    };

    // Two of the four go to an earlier digest…
    const ownerId = stage('digest-took-the-first-two', sourceIds.slice(0, 2));
    expect(applyProposal(db, ownerId, kg).sourcesArchived).toBe(2);
    // …and the other two are forgotten before this proposal is applied.
    for (const id of sourceIds.slice(2)) db.prepare('DELETE FROM entities WHERE id = ?').run(id);

    const mixedId = stage('digest-left-with-nothing', sourceIds);
    expect(() => applyProposal(db, mixedId, kg)).toThrow(/claimed nothing/);

    const after = db.prepare('SELECT status, reason FROM dream_proposals WHERE id = ?').get(mixedId) as { status: string; reason: string | null };
    expect(after.status).toBe('rejected');
    // Both counts, each accurate. "all 4 were already summarised" is the lie
    // this guards: it sends the operator looking for two duplicate digests
    // that do not exist, instead of at the forget that took the other two.
    expect(after.reason, 'a mixed empty claim named only one of its two causes')
      .toMatch(/2 were already summarised by another digest and 2 no longer exist/);
    expect(after.reason).not.toMatch(/all 4/);
  });

  it('pattern apply: refuses a pattern whose sources have all been forgotten', async () => {
    // Same hole, other branch, other route in: the pattern loop skips a source
    // whose row is gone (`if (!sourceRow) continue`), so forgetting the sources
    // between proposing and applying produced a pattern_emergent entity with
    // zero `evidence_for` edges — a claim about a pattern with no evidence,
    // orphaned in the graph view, reported as applied.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(4);
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('memesh', 'pattern:2026-W19', ?, ?, 'v1')
    `).run(JSON.stringify(sourceIds), JSON.stringify({
      name: 'pattern-with-no-evidence',
      type: 'pattern_emergent',
      observations: ['Pattern: every commit touching X also touches Y'],
      tags: ['pattern_emergent', 'project:memesh'],
    }));
    const proposalId = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;

    for (const id of sourceIds) db.prepare('DELETE FROM entities WHERE id = ?').run(id);

    expect(() => applyProposal(db, proposalId, kg)).toThrow(/claimed nothing/);
    expect(
      db.prepare("SELECT id FROM entities WHERE name = 'pattern-with-no-evidence'").get(),
      'a pattern with no evidence was still written to the graph'
    ).toBeUndefined();
    const after = db.prepare('SELECT status, reason FROM dream_proposals WHERE id = ?').get(proposalId) as { status: string; reason: string | null };
    expect(after.status).toBe('rejected');
    expect(after.reason).toMatch(/still exist/);
  });

  it('apply: refuses a second apply of the same proposal', async () => {
    // Covers the SELECT guard, not the terminal UPDATE's `AND status =
    // 'pending'` — that one needs a second process changing the row between
    // the SELECT and the UPDATE, which this suite cannot stage, and it says so
    // at the line itself rather than looking covered here.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(6);
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('memesh', '2026-W19', ?, ?, 'v1')
    `).run(JSON.stringify(sourceIds), JSON.stringify({
      name: 'digest-raced', type: 'digest', observations: ['summary'], tags: ['digest'],
    }));
    const id = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number }).id;

    expect(applyProposal(db, id, kg).sourcesArchived).toBe(6);
    // Second apply of the same id: the row is no longer pending.
    expect(() => applyProposal(db, id, kg)).toThrow(/not found or not pending|stopped being pending/);
  });

  it('apply: writes a digest entity, soft-archives sources, links via metadata.compacted_into', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(6);
    // Manually insert a pending staged proposal
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'memesh',
      '2026-W19',
      JSON.stringify(sourceIds),
      JSON.stringify({
        name: 'digest-2026-W19-feature-thing',
        type: 'digest',
        observations: ['Consolidated 6 commits implementing the feature thing across week 19'],
        tags: ['digest', 'project:memesh', 'week:2026-W19'],
      }),
      'v1',
    );
    const proposalRow = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    const result = applyProposal(db, proposalRow.id, kg);
    expect(result.sourcesArchived).toBe(6);
    expect(result.digestEntityName).toBe('digest-2026-W19-feature-thing');

    // Digest entity should exist and be active
    const digest = db.prepare("SELECT id, status, metadata FROM entities WHERE name = ?").get('digest-2026-W19-feature-thing') as any;
    expect(digest).toBeDefined();
    expect(digest.status).toBe('active');
    const digestMeta = JSON.parse(digest.metadata);
    expect(digestMeta.consolidation_depth).toBe(1);
    expect(digestMeta.source_ids).toEqual(sourceIds);

    // Sources should be archived AND linked to the digest
    for (const sourceId of sourceIds) {
      const source = db.prepare('SELECT status, metadata FROM entities WHERE id = ?').get(sourceId) as any;
      expect(source.status).toBe('archived');
      const meta = JSON.parse(source.metadata);
      expect(meta.compacted_into).toBe(digest.id);
    }

    // Proposal status flipped to 'applied'
    const updatedProposal = db.prepare('SELECT status, reviewed_at FROM dream_proposals WHERE id = ?').get(proposalRow.id) as any;
    expect(updatedProposal.status).toBe('applied');
    expect(updatedProposal.reviewed_at).toBeDefined();
  });

  it('reject: source entities untouched, proposal marked rejected with reason', async () => {
    const { rejectProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(6);
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, ?, ?, ?, ?)
    `).run('memesh', '2026-W19', JSON.stringify(sourceIds), JSON.stringify({
      name: 'bad-digest', type: 'digest', observations: ['nope'], tags: [],
    }), 'v1');
    const proposalRow = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    rejectProposal(db, proposalRow.id, 'incoherent grouping');

    // Sources still active
    for (const sourceId of sourceIds) {
      const s = db.prepare('SELECT status FROM entities WHERE id = ?').get(sourceId) as any;
      expect(s.status).toBe('active');
    }
    // Proposal status flipped
    const updated = db.prepare('SELECT status, reason FROM dream_proposals WHERE id = ?').get(proposalRow.id) as any;
    expect(updated.status).toBe('rejected');
    expect(updated.reason).toBe('incoherent grouping');
  });

  it('apply throws on a non-existent or already-applied proposal', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    expect(() => applyProposal(db, 99999, kg)).toThrow(/not found or not pending/);
  });

  it('pattern apply: creates pattern_emergent entity, links sources via evidence_for, does NOT archive', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(4);

    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'memesh',
      'pattern:2026-05-08',
      JSON.stringify(sourceIds),
      JSON.stringify({
        name: 'pattern-recurring-thing',
        type: 'pattern_emergent',
        observations: ['Pattern: every commit touching X also touches Y'],
        tags: ['pattern_emergent', 'project:memesh'],
      }),
      'v1',
    );
    const proposalRow = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    const result = applyProposal(db, proposalRow.id, kg);
    // Aligned with ProposalSummary.kind discriminator — earlier the
    // apply path returned 'pattern' (abbreviated) which created
    // contract drift with the listing path. Pinned at the canonical
    // 'pattern_emergent' value as part of the v4.2.0 cleanup.
    expect(result.kind).toBe('pattern_emergent');
    expect(result.sourcesLinked).toBe(4);
    expect(result.sourcesArchived).toBe(0);

    // Pattern entity exists, sources still active
    const pattern = db.prepare("SELECT id, status, metadata FROM entities WHERE name = ?").get('pattern-recurring-thing') as any;
    expect(pattern.status).toBe('active');
    const meta = JSON.parse(pattern.metadata);
    expect(meta.kind).toBe('pattern_emergent');
    expect(meta.consolidation_depth).toBeUndefined(); // patterns aren't depth-counted

    for (const sourceId of sourceIds) {
      const source = db.prepare('SELECT status, metadata FROM entities WHERE id = ?').get(sourceId) as any;
      expect(source.status).toBe('active'); // NOT archived
      const sourceMeta = JSON.parse(source.metadata);
      expect(sourceMeta.evidence_for).toContain(pattern.id);
      expect(sourceMeta.compacted_into).toBeUndefined(); // not compacted
    }
  });

  // -------------------------------------------------------------------------
  // digest_observations_preview: null, not the '(empty)' sentinel
  // -------------------------------------------------------------------------

  it('listProposals reports a missing first observation as null, not the "(empty)" sentinel', async () => {
    // '(empty)' was a magic string every consumer had to know about — the
    // dashboard string-compared it, the CLI printed it as if it were
    // content, and no locale could translate it. null is the honest value.
    const { listProposals } = await import('../../src/core/dreamer.js');
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, ?, ?, ?, ?)
    `).run('memesh', '2026-W30', '[1,2]',
      JSON.stringify({ name: 'no-observations', type: 'digest', observations: [], tags: [] }),
      'v1');

    const rows = listProposals(db, 'pending');
    expect(rows).toHaveLength(1);
    expect(rows[0].digest_observations_preview).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain('(empty)');
  });

  it('listProposals still returns the truncated first observation when one exists', async () => {
    const { listProposals } = await import('../../src/core/dreamer.js');
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, ?, ?, ?, ?)
    `).run('memesh', '2026-W31', '[3,4]',
      JSON.stringify({ name: 'has-observations', type: 'digest', observations: ['x'.repeat(200)], tags: [] }),
      'v1');

    const rows = listProposals(db, 'pending');
    expect(rows[0].digest_observations_preview).toBe('x'.repeat(120));
  });

  // -------------------------------------------------------------------------
  // Provenance: a dreamer entity contains untrusted agent-submitted text
  //
  // `createLesson` marks the identical threat model `untrusted` and its header
  // says why: an agent paraphrase of a session transcript, which may carry text
  // a dependency or a PR title printed. The dreamer is the same class and was
  // the only generation path that never set the marker — and BOTH consumers of
  // that marker default to allow when it is absent, so both are checked here.
  //
  // Not a break-out: the auto-context fence collapses whitespace and cannot be
  // closed from inside. This is about what gets pushed into context unprompted.
  // -------------------------------------------------------------------------

  it('makes an ACCEPTED digest auto-context eligible, without lifting its confidence', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const { isTrustedForAutoContext } = await import('../../scripts/hooks/_shared.js');
    const sourceIds = seedCommits(4);

    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, ?, ?, ?, ?)
    `).run('memesh', 'memesh::wk-19', JSON.stringify(sourceIds),
      JSON.stringify({ name: 'wk-19-digest', type: 'digest', observations: ['Summary of the week'], tags: ['digest'] }),
      'v1');
    const proposal = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    applyProposal(db, proposal.id, kg);

    const row = db.prepare('SELECT metadata FROM entities WHERE name = ?').get('wk-19-digest') as { metadata: string };

    // `applyProposal` only ever runs from `dream accept`, so reaching this
    // line means a human said yes. Blocking it from auto-context protected
    // nothing while the raw commits it summarises stayed 100% injectable —
    // measured on a real graph, 74/74 commits in versus 0/29 facts. The
    // consumer is asserted, not the field: `isTrustedForAutoContext` is what
    // session-start and pre-edit actually call.
    expect(
      isTrustedForAutoContext(row.metadata),
      'a digest the user accepted is still being withheld from auto-context'
    ).toBe(true);

    // The other half of the same decision, and the reason this is one test:
    // eligibility moved, the confidence policy did NOT. `createEntity` reads
    // `trustOverride ?? metadata.trust`, so dropping the metadata key without
    // passing the override would silently re-enable the bump this project
    // spent three review rounds closing.
    const proposalMeta = JSON.parse(row.metadata);
    expect(proposalMeta.proposal_id, 'lost the marker that proves human acceptance').toBe(proposal.id);
  });

  it('makes an ACCEPTED pattern auto-context eligible too', async () => {
    // Patterns are staged by the Stop hook automatically and land at
    // signal_score 0.9 — the highest in the codebase. Staging is not
    // acceptance: the proposal sits in `dream_proposals` until a human
    // accepts, and only then does this entity exist at all.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const { isTrustedForAutoContext } = await import('../../scripts/hooks/_shared.js');
    const sourceIds = seedCommits(4);

    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, ?, ?, ?, ?)
    `).run('memesh', 'pattern:2026-08-03', JSON.stringify(sourceIds),
      JSON.stringify({ name: 'pattern-thing', type: 'pattern_emergent', observations: ['A pattern'], tags: ['pattern_emergent'] }),
      'v1');
    const proposal = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    applyProposal(db, proposal.id, kg);

    const row = db.prepare('SELECT metadata FROM entities WHERE name = ?').get('pattern-thing') as { metadata: string };
    expect(isTrustedForAutoContext(row.metadata)).toBe(true);
  });

  it('does not let submitted text lift a digest\'s confidence on re-apply', async () => {
    // The write-side half of the policy, which auto-context eligibility
    // moving did NOT change. knowledge-graph's confidence bump reads
    // `trustOverride ?? metadata.trust` and treats a missing value as
    // trusted, so `applyProposal` states the override explicitly.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    // Eight sources, four per proposal. Both proposals used to share ONE set of
    // four — which is now refused outright, because the second would claim none
    // of them. The re-apply this test is about is a second write to the same
    // digest NAME, not a second write over the same sources, so splitting the
    // sources keeps the thing under test and drops the thing that is a defect.
    const sourceIds = seedCommits(8);

    function stage(observations: string[], ids: number[]): number {
      db.prepare(`
        INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
        VALUES (?, ?, ?, ?, ?)
      `).run('memesh', 'memesh::wk-20', JSON.stringify(ids),
        JSON.stringify({ name: 'repeat-digest', type: 'digest', observations, tags: ['digest'] }),
        'v1');
      return (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;
    }

    applyProposal(db, stage(['first summary'], sourceIds.slice(0, 4)), kg);
    db.prepare('UPDATE entities SET confidence = 0.5 WHERE name = ?').run('repeat-digest');
    applyProposal(db, stage(['a brand new summary line'], sourceIds.slice(4)), kg);

    const after = db.prepare('SELECT confidence AS c FROM entities WHERE name = ?').get('repeat-digest') as { c: number };
    expect(after.c, 'agent-submitted text lifted its own confidence').toBeCloseTo(0.5, 5);
  });

  it('files a digest under the cluster\'s project, not one the agent named', async () => {
    // `digest.tags` comes back from the agent and `project:` is what tag-filtered
    // recall routes on, so a tag lifted out of injected source text could file
    // the digest under someone else's project.
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(4);

    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES (?, ?, ?, ?, ?)
    `).run('memesh', 'memesh::wk-21', JSON.stringify(sourceIds),
      JSON.stringify({
        name: 'misfiled-digest', type: 'digest', observations: ['x'],
        tags: ['digest', 'project:someone-elses-project', 'topic:auth'],
      }),
      'v1');
    const proposal = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    applyProposal(db, proposal.id, kg);

    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get('misfiled-digest') as { id: number };
    const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(entity.id) as Array<{ tag: string }>).map(r => r.tag);
    expect(tags, 'the agent routed the digest into another project').not.toContain('project:someone-elses-project');
    expect(tags).toContain('project:memesh');
    expect(tags, 'descriptive tags were thrown away along with the routing one').toContain('topic:auth');
  });

  it('transcript apply cannot overwrite a rejection that lands after the pending read', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    db.prepare(`
      INSERT INTO dream_proposals
        (project, cluster_key, source_ids, proposed_digest, prompt_version, source_kind, kind)
      VALUES (?, ?, ?, ?, 'work-package-v1', 'transcript', 'digest')
    `).run(
      'memesh',
      'transcript:session-race',
      JSON.stringify({ sessionId: 'session-race' }),
      JSON.stringify({
        name: 'raced-transcript-memory',
        type: 'decision',
        observations: ['Use the smaller implementation.'],
        tags: ['decision'],
      }),
    );
    const proposal = db.prepare(
      "SELECT id FROM dream_proposals WHERE status = 'pending' ORDER BY id DESC",
    ).get() as { id: number };

    // The facade settles the row after applyProposal's outer pending SELECT
    // but before applyTranscriptProposal starts its transaction. This is the
    // exact race window the inner status-guard must close.
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (body: () => unknown) => {
            const transaction = target.transaction(body);
            const run = (...args: unknown[]) => {
              target.prepare(
                "UPDATE dream_proposals SET status = 'rejected', reason = 'other reviewer' WHERE id = ? AND status = 'pending'",
              ).run(proposal.id);
              return transaction(...args);
            };
            run.immediate = (...args: unknown[]) => {
              target.prepare(
                "UPDATE dream_proposals SET status = 'rejected', reason = 'other reviewer' WHERE id = ? AND status = 'pending'",
              ).run(proposal.id);
              return transaction.immediate(...args);
            };
            return run;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    expect(() => applyProposal(racingDb, proposal.id, kg)).toThrow(/reviewed concurrently/);
    expect(db.prepare('SELECT status, reason FROM dream_proposals WHERE id = ?').get(proposal.id))
      .toEqual({ status: 'rejected', reason: 'other reviewer' });
    expect(db.prepare("SELECT id FROM entities WHERE name = 'raced-transcript-memory'").get())
      .toBeUndefined();
  });
});
