import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { scorePrompt, selectPromptRecall, PROMPT_RECALL_MIN_COVERAGE, PROMPT_RECALL_MAX_TERM_SHARE, PROMPT_RECALL_SKIP_TYPES, PROMPT_RECALL_MAX_PROJECT_AGE_DAYS } from '../../src/core/prompt-recall.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-prompt-recall-');

const PROJECT = 'proj~0123456789abcdef0123456789abcdef';
const tags = [`project:${PROJECT}`];
const kg = () => new KnowledgeGraph(getDatabase());
const pick = (prompt: string, extra: Record<string, unknown> = {}) => selectPromptRecall(getDatabase(), prompt, { project: PROJECT, ...extra });

describe('Feature: prompt recall scoring', () => {
  it('reads every observation of a memory, not only the first', () => {
    kg().createEntity('later-fact', 'reference', {
      title: 'Release checklist',
      observations: ['The checklist has many steps.', 'Step nine rotates the zebrafish credentials.', 'Step ten archives the quokka report.'],
      tags,
    });
    const hit = pick('which step rotates the zebrafish credentials and archives the quokka report');
    expect(hit.ids).toHaveLength(1);
    expect(hit.scored[0].matched).toEqual(expect.arrayContaining(['zebrafish', 'quokka']));
  });

  it('cuts a Chinese prompt into words, so a word spanning two pairs is one term and a boundary-straddling pair is not', () => {
    kg().createEntity('companion-rule', 'decision', {
      title: '陪診員看不到病患住家地址',
      observations: ['陪診員只看得到區域，不顯示病患住家地址。', 'Why: 隱私；若要派單需要地址再重新評估。'],
      tags,
    });
    const hit = pick('陪診員不應該看得到病患的住家地址嗎');
    expect(hit.ids).toHaveLength(1);
    // Whole words, not the overlapping pairs the index stores.
    expect(hit.terms).toEqual(expect.arrayContaining(['陪診員']));
    expect(hit.terms.every((t) => !['員不', '應該看'].includes(t))).toBe(true);
  });

  it('a word nearly every memory holds takes no part in the match', () => {
    const graph = kg();
    for (let i = 0; i < 40; i++) graph.createEntity(`filler-${i}`, 'reference', { title: `Filler ${i}`, observations: [`commonword filler number ${i}`], tags });
    graph.createEntity('target', 'reference', { title: 'Narwhal tuning', observations: ['commonword narwhal tuning notes'], tags });
    const { terms, scored } = scorePrompt(getDatabase(), 'commonword narwhal tuning', { project: PROJECT });
    expect(terms).not.toContain('commonword');
    expect(scored[0].name).toBe('target');
    expect(PROMPT_RECALL_MAX_TERM_SHARE).toBeLessThan(0.1);
  });

  it('replaying an earlier time hides a memory written afterwards and the text added to one later', () => {
    const graph = kg();
    const db = getDatabase();
    graph.createEntity('old-and-complete', 'reference', { title: 'Platypus handbook', observations: ['platypus handbook chapter marmot'], tags });
    graph.createEntity('written-later', 'reference', { title: 'Platypus marmot summary', observations: ['platypus marmot summary'], tags });
    graph.createEntity('rewritten-later', 'reference', { title: 'Platypus marmot digest', observations: ['platypus marmot digest'], tags });
    db.prepare("UPDATE entities SET created_at = '2026-01-01 00:00:00' WHERE name IN ('old-and-complete', 'rewritten-later')").run();
    db.prepare("UPDATE entities SET created_at = '2026-03-01 00:00:00' WHERE name = 'written-later'").run();
    db.prepare("UPDATE observations SET created_at = '2026-01-01 00:00:00' WHERE entity_id = (SELECT id FROM entities WHERE name = 'old-and-complete')").run();
    // This memory existed in January, but everything it says was written in March.
    db.prepare("UPDATE observations SET created_at = '2026-03-01 00:00:00' WHERE entity_id = (SELECT id FROM entities WHERE name = 'rewritten-later')").run();

    // Created in March with text dated January: still not there in February.
    graph.createEntity('backdated', 'reference', { title: 'Platypus marmot ledger', observations: ['platypus marmot ledger'], tags });
    db.prepare("UPDATE entities SET created_at = '2026-03-01 00:00:00' WHERE name = 'backdated'").run();
    db.prepare("UPDATE observations SET created_at = '2026-01-01 00:00:00' WHERE entity_id = (SELECT id FROM entities WHERE name = 'backdated')").run();

    const asOf = Date.parse('2026-02-01T00:00:00Z');
    const early = pick('platypus marmot', { createdBefore: asOf, minCoverage: 0.1 });
    expect(early.scored.map((m) => m.name)).toEqual(['old-and-complete']);
    const now = pick('platypus marmot', { minCoverage: 0.1 });
    expect(now.scored.map((m) => m.name).sort()).toEqual(['backdated', 'old-and-complete', 'rewritten-later', 'written-later']);
  });

  it('searches the project it is given, memories with no project and global ones, and no other project', () => {
    const graph = kg();
    graph.createEntity('here', 'reference', { title: 'Axolotl pond', observations: ['axolotl pond depth'], tags: [`project:${PROJECT}`] });
    graph.createEntity('elsewhere', 'reference', { title: 'Axolotl pond lining', observations: ['axolotl pond lining'], tags: ['project:other~eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'] });
    graph.createEntity('free', 'preference', { title: 'Axolotl pond filter', observations: ['axolotl pond filter'] });
    expect(pick('axolotl pond').scored.map((m) => m.name).sort()).toEqual(['free', 'here']);
  });

  it('ignores markup tags around a pasted command, which are not words the person chose', () => {
    kg().createEntity('shell-note', 'reference', { title: 'Bash input notes', observations: ['bash input handling for the quokka script'], tags });
    const { terms } = scorePrompt(getDatabase(), '<bash-input>quokka script</bash-input>', { project: PROJECT });
    expect(terms).toEqual(expect.arrayContaining(['quokka', 'script']));
    expect(terms).not.toContain('bash');
    expect(terms).not.toContain('input');
  });

  it('by default writing-style and working-style notes (feedback, engineering_feedback) are never brought along; other types are', () => {
    kg().createEntity('style-rule', 'feedback', { title: 'Heron migration notes', observations: ['heron migration notes for the lagoon'], tags });
    kg().createEntity('eng-rule', 'engineering_feedback', { title: 'Heron migration habits', observations: ['heron migration habits for the lagoon'], tags });
    kg().createEntity('plain-fact', 'reference', { title: 'Heron migration lagoon', observations: ['heron migration lagoon counts'], tags });
    const prompt = 'heron migration lagoon';
    expect(pick(prompt).scored.map((m) => m.name)).toEqual(['plain-fact']);
    // An explicit empty set offers every type, and a named set only that one.
    expect(pick(prompt, { skipTypes: new Set() }).scored.map((m) => m.name).sort()).toEqual(['eng-rule', 'plain-fact', 'style-rule']);
    expect(pick(prompt, { skipTypes: new Set(['reference']) }).scored.map((m) => m.name).sort()).toEqual(['eng-rule', 'style-rule']);
  });

  it('by default a project status not touched for 30 days is not brought along, and nothing of another type is held back by age', () => {
    const db = getDatabase();
    kg().createEntity('old-status', 'project', { title: 'Curlew roadmap status', observations: ['curlew roadmap status unresolved'], tags });
    kg().createEntity('fresh-status', 'project', { title: 'Curlew roadmap review', observations: ['curlew roadmap review done'], tags });
    kg().createEntity('old-lesson', 'lesson_learned', { title: 'Curlew roadmap lesson', observations: ['curlew roadmap lesson learned'], tags });
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare("UPDATE observations SET created_at = ? WHERE entity_id IN (SELECT id FROM entities WHERE name IN ('old-status', 'old-lesson'))").run(days(60));
    db.prepare("UPDATE observations SET created_at = ? WHERE entity_id = (SELECT id FROM entities WHERE name = 'fresh-status')").run(days(5));
    const prompt = 'curlew roadmap';
    expect(pick(prompt).scored.map((m) => m.name).sort()).toEqual(['fresh-status', 'old-lesson']);
    expect(pick(prompt, { maxProjectAgeDays: null }).scored.map((m) => m.name).sort()).toEqual(['fresh-status', 'old-lesson', 'old-status']);
    expect(pick(prompt, { maxProjectAgeDays: 90 }).scored.map((m) => m.name).sort()).toEqual(['fresh-status', 'old-lesson', 'old-status']);
  });

  it('by default a note-file memory is dated by the file, not by the day it was read', () => {
    const db = getDatabase();
    kg().createEntity('imported-status', 'project', {
      title: 'Godwit rollout status', observations: ['godwit rollout status unresolved'], tags,
      metadata: { trust: 'trusted', provenance: { source: 'note-file', note_mtime_ms: Date.now() - 80 * 86_400_000 } },
    });
    // Read just now, so by its observations alone it is new.
    const prompt = 'godwit rollout';
    expect(pick(prompt).scored).toEqual([]);
    expect(pick(prompt, { projectAgeFromNoteDate: false }).scored.map((m) => m.name)).toEqual(['imported-status']);
    // A file changed yesterday is new, whatever the age of the memory's first read.
    db.prepare("UPDATE entities SET metadata = json_set(metadata, '$.provenance.note_mtime_ms', ?) WHERE name = 'imported-status'").run(Date.now() - 86_400_000);
    expect(pick(prompt).scored.map((m) => m.name)).toEqual(['imported-status']);
  });

  it('keeps the measured defaults', () => {
    expect(PROMPT_RECALL_MIN_COVERAGE).toBe(0.5);
    expect(PROMPT_RECALL_MAX_TERM_SHARE).toBe(0.03);
    expect([...PROMPT_RECALL_SKIP_TYPES].sort()).toEqual(['engineering_feedback', 'feedback']);
    expect(PROMPT_RECALL_MAX_PROJECT_AGE_DAYS).toBe(30);
  });
});
