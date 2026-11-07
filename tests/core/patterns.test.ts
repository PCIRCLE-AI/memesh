import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { forget, learn, remember } from '../../src/core/operations.js';
import { computePatterns } from '../../src/core/patterns.js';
import { compressWeeklyNoise } from '../../src/core/lifecycle.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-patterns-');

describe('computePatterns', () => {
  it('returns all pattern categories for empty database', () => {
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule).toBeDefined();
    expect(result.workSchedule.hourDistribution).toEqual([]);
    expect(result.workSchedule.dayDistribution).toEqual([]);
    expect(result.focusAreas).toEqual([]);
    expect(result.workflow.totalSessions).toBe(0);
    expect(result.workflow.totalCommits).toBe(0);
    expect(result.workflow.commitsPerSession).toBe(0);
    expect(result.strengths).toEqual([]);
    expect(result.learningAreas).toEqual([]);
  });

  it('computes focus areas excluding auto-tracked types', () => {
    remember({ name: 'e1', type: 'decision', why: 'the simplest layout; revisit if it stops scaling', observations: ['arch choice'] });
    remember({ name: 'e2', type: 'session_keypoint', observations: ['[SESSION] test'] });
    remember({ name: 'e3', type: 'lesson_learned', observations: ['Error: test'] });
    remember({ name: 'e4', type: 'commit', observations: ['fix: something'] });
    const db = getDatabase();
    const result = computePatterns(db);
    const types = result.focusAreas.map(f => f.type);
    expect(types).toContain('decision');
    expect(types).toContain('lesson_learned');
    expect(types).not.toContain('session_keypoint');
    expect(types).not.toContain('commit');
  });

  it('does not count the session handoff as a focus area', () => {
    remember({ name: 'e1', type: 'decision', why: 'the simplest layout; revisit if it stops scaling', observations: ['arch choice'] });
    remember({ name: 'session-handoff:p', type: 'session-handoff', observations: ['Stopped right before the release step.'] });
    const types = computePatterns(getDatabase()).focusAreas.map((f) => f.type);
    expect(types).toContain('decision');
    expect(types).not.toContain('session-handoff');
  });

  it('filters by categories when specified', () => {
    remember({ name: 'e1', type: 'decision', why: 'a placeholder choice; revisit if the test changes', observations: ['test'] });
    const db = getDatabase();
    const result = computePatterns(db, ['workflow']);
    expect(result.workflow).toBeDefined();
    expect(result.workflow.totalSessions).toBe(0);
    // Categories not requested should be empty defaults
    expect(result.focusAreas).toEqual([]);
    expect(result.strengths).toEqual([]);
  });

  it('computes hour distribution ordered by hour', () => {
    remember({ name: 'e1', type: 'concept', observations: ['test'] });
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule.hourDistribution.length).toBeGreaterThan(0);
    const total = result.workSchedule.hourDistribution.reduce((s, h) => s + h.count, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('emits numeric dayNum (0-6) and no baked-in day name', () => {
    remember({ name: 'e1', type: 'concept', observations: ['test'] });
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule.dayDistribution.length).toBeGreaterThan(0);
    for (const entry of result.workSchedule.dayDistribution) {
      expect(entry).toHaveProperty('dayNum');
      expect(entry).toHaveProperty('count');
      expect(typeof entry.dayNum).toBe('number');
      expect(entry.dayNum).toBeGreaterThanOrEqual(0);
      expect(entry.dayNum).toBeLessThanOrEqual(6);
      // The English day-name column was removed on purpose (i18n): the
      // wire carries the number, each surface localises it.
      expect(entry).not.toHaveProperty('day');
    }
  });
});

describe('computePatterns: numbers that match their names', () => {
  it('counts one session once, however many records the capture wrote', () => {
    // The Stop hook writes up to three session-insight records per conversation
    // (-files, -fixes, -summary), all tagged with the same `session:<id>`.
    for (const part of ['files', 'fixes', 'summary']) {
      remember({ name: `session-one-${part}`, type: 'session-insight', observations: [`[SESSION] ${part}`], tags: ['session:one'] });
    }
    remember({ name: 'commit-1', type: 'commit', observations: ['fix: one'] });
    const workflow = computePatterns(getDatabase(), ['workflow']).workflow;
    expect(workflow.totalSessions).toBe(1);
    expect(workflow.totalCommits).toBe(1);
    expect(workflow.commitsPerSession).toBe(1);
  });

  it('counts two sessions twice, and a legacy record with no session tag as one', () => {
    remember({ name: 'a-files', type: 'session-insight', observations: ['x'], tags: ['session:a'] });
    remember({ name: 'a-summary', type: 'session-insight', observations: ['x'], tags: ['session:a'] });
    remember({ name: 'b-files', type: 'session-insight', observations: ['x'], tags: ['session:b'] });
    remember({ name: 'old-keypoint', type: 'session_keypoint', observations: ['[SESSION] old'] });
    expect(computePatterns(getDatabase(), ['workflow']).workflow.totalSessions).toBe(3);
  });

  it('does not count weekly summaries or session summaries as focus areas or strengths', () => {
    remember({ name: 'e1', type: 'decision', why: 'the simplest layout; revisit if it stops scaling', observations: ['arch choice'] });
    for (const type of ['weekly-summary', 'session-summary', 'session-identity']) {
      remember({ name: `${type}-1`, type, observations: ['auto'] });
      remember({ name: `${type}-2`, type, observations: ['auto'] });
    }
    const result = computePatterns(getDatabase());
    for (const type of ['weekly-summary', 'session-summary', 'session-identity']) {
      expect(result.focusAreas.map((f) => f.type)).not.toContain(type);
      expect(result.strengths.map((f) => f.type)).not.toContain(type);
    }
    expect(result.focusAreas.map((f) => f.type)).toContain('decision');
  });

  it('keeps the labels memory writes on its own out of the learning areas', () => {
    learn({ error: 'async handler dropped an error', fix: 'await the promise', root_cause: 'missing await', severity: 'minor', project: 'proj' });
    remember({ name: 'l2', type: 'lesson_learned', observations: ['Error: x'], tags: ['async', 'memory', 'project:proj', 'source:explicit', 'severity:minor', 'error-pattern:other'] });
    const tags = computePatterns(getDatabase(), ['learningAreas']).learningAreas.map((l) => l.tag);
    expect(tags).toContain('async');
    for (const label of ['project:proj', 'source:explicit', 'severity:minor', 'error-pattern:other']) {
      expect(tags).not.toContain(label);
    }
    expect(tags.some((t) => /^(project|source|severity|error-pattern):/.test(t))).toBe(false);
  });

  it('leaves archived memories out of the work schedule', () => {
    remember({ name: 'keep', type: 'concept', observations: ['x'] });
    remember({ name: 'gone', type: 'concept', observations: ['x'] });
    forget({ name: 'gone' });
    const schedule = computePatterns(getDatabase(), ['workSchedule']).workSchedule;
    expect(schedule.hourDistribution.reduce((n, h) => n + h.count, 0)).toBe(1);
    expect(schedule.dayDistribution.reduce((n, d) => n + d.count, 0)).toBe(1);
  });

  it('applies one rule to the whole response: archived memories count nowhere', () => {
    remember({ name: 'c1', type: 'commit', observations: ['fix: one'] });
    remember({ name: 'c2', type: 'commit', observations: ['fix: two'] });
    remember({ name: 's-a', type: 'session-insight', observations: ['x'], tags: ['session:a'] });
    remember({ name: 's-b', type: 'session-insight', observations: ['x'], tags: ['session:b'] });
    remember({ name: 'k-old', type: 'session_keypoint', observations: ['[SESSION] old'] });
    forget({ name: 'c2' });
    forget({ name: 's-b' });
    forget({ name: 'k-old' });
    const result = computePatterns(getDatabase());
    expect(result.workflow.totalCommits).toBe(1);
    expect(result.workflow.totalSessions).toBe(1);
    expect(result.workSchedule.hourDistribution.reduce((n, h) => n + h.count, 0)).toBe(2);
  });

  it('keeps topic tags that merely start like a system label, and drops the labels themselves', () => {
    remember({
      name: 'l-tags', type: 'lesson_learned', observations: ['Error: x'],
      tags: ['automation', 'autoscaling', 'sessions', 'auto', 'auto_saved', 'auto-captured', 'session_end', 'session:abc', 'scope:project', 'date:2026-11-01'],
    });
    const tags = computePatterns(getDatabase(), ['learningAreas']).learningAreas.map((l) => l.tag).sort();
    expect(tags).toEqual(['automation', 'autoscaling', 'sessions']);
  });

  it('drops the topics of a lesson the person forgot', () => {
    remember({ name: 'l-keep', type: 'lesson_learned', observations: ['Error: x'], tags: ['caching'] });
    remember({ name: 'l-gone', type: 'lesson_learned', observations: ['Error: y'], tags: ['retries'] });
    forget({ name: 'l-gone' });
    expect(computePatterns(getDatabase(), ['learningAreas']).learningAreas.map((l) => l.tag)).toEqual(['caching']);
  });

  it('shows no learning areas to someone who only records lessons with learn', () => {
    // learn writes project:, source:, severity: and error-pattern: labels and no topic of its own.
    learn({ error: 'async handler dropped an error', fix: 'await the promise', root_cause: 'missing await', severity: 'minor', project: 'proj' });
    expect(computePatterns(getDatabase(), ['learningAreas']).learningAreas).toEqual([]);
  });

  describe('records that lifecycle compression archived are still the work that was done', () => {
    /** 25 commits ten days ago: past the 7-day age and the 20-per-week threshold compression uses. */
    function seedOldCommits(): void {
      for (let i = 0; i < 25; i++) remember({ name: `old-commit-${i}`, type: 'commit', observations: [`fix: ${i}`] });
      getDatabase().exec("UPDATE entities SET created_at = datetime('now', '-10 days', '+3 hours') WHERE name LIKE 'old-commit-%'");
    }
    const scheduleTotal = () => computePatterns(getDatabase(), ['workSchedule']).workSchedule.hourDistribution.reduce((n, h) => n + h.count, 0);
    const peakHour = () => [...computePatterns(getDatabase(), ['workSchedule']).workSchedule.hourDistribution].sort((a, b) => b.count - a.count)[0];

    it('keeps the work schedule and the workflow counts the same after a week is compressed', () => {
      seedOldCommits();
      const before = computePatterns(getDatabase());
      const result = compressWeeklyNoise(getDatabase());
      expect(result.compressed).toBe(25);
      // The commits really are archived now, and a weekly-summary exists.
      expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'commit' AND status = 'archived'").get() as { n: number }).n).toBe(25);
      const after = computePatterns(getDatabase());
      expect(after.workflow.totalCommits).toBe(before.workflow.totalCommits);
      expect(after.workflow.totalCommits).toBe(25);
      expect(after.workSchedule).toEqual(before.workSchedule);
      expect(peakHour().count).toBe(25);
    });

    it('does not count the weekly summary itself, whose time is the moment of compression', () => {
      seedOldCommits();
      compressWeeklyNoise(getDatabase());
      expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'weekly-summary'").get() as { n: number }).n).toBe(1);
      expect(scheduleTotal()).toBe(25);
    });

    it('does not count a commit the person forgot in a week that was never compressed', () => {
      remember({ name: 'c-keep', type: 'commit', observations: ['fix: keep'] });
      remember({ name: 'c-gone', type: 'commit', observations: ['fix: gone'] });
      forget({ name: 'c-gone' });
      const result = computePatterns(getDatabase());
      expect(result.workflow.totalCommits).toBe(1);
      expect(scheduleTotal()).toBe(1);
    });

    it('still counts a commit forgotten after its week was compressed: compression had already recorded it', () => {
      seedOldCommits();
      compressWeeklyNoise(getDatabase());
      forget({ name: 'old-commit-3' });
      expect(computePatterns(getDatabase()).workflow.totalCommits).toBe(25);
      expect(scheduleTotal()).toBe(25);
    });

    it('does not bring a forgotten commit back when its week is compressed afterwards', () => {
      seedOldCommits();
      forget({ name: 'old-commit-3' });
      forget({ name: 'old-commit-4' });
      expect(computePatterns(getDatabase()).workflow.totalCommits).toBe(23);
      expect(compressWeeklyNoise(getDatabase()).compressed).toBe(23);
      const after = computePatterns(getDatabase());
      expect(after.workflow.totalCommits).toBe(23);
      expect(scheduleTotal()).toBe(23);
    });

    it('counts rows the dreamer archived (metadata.compacted_into) even when their week has no weekly summary', () => {
      for (let i = 0; i < 7; i++) remember({ name: `dreamed-${i}`, type: 'commit', observations: [`fix: ${i}`] });
      // What dreamer.ts writes when it takes a source: archived + compacted_into.
      getDatabase().exec(`UPDATE entities SET status = 'archived', metadata = json_set(COALESCE(metadata, '{}'), '$.compacted_into', 999) WHERE name LIKE 'dreamed-%'`);
      expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'weekly-summary'").get() as { n: number }).n).toBe(0);
      expect(computePatterns(getDatabase()).workflow.totalCommits).toBe(7);
      expect(scheduleTotal()).toBe(7);
    });

    it('does not count an archived commit that carries no compaction marker', () => {
      for (let i = 0; i < 3; i++) remember({ name: `plain-${i}`, type: 'commit', observations: [`fix: ${i}`] });
      getDatabase().exec("UPDATE entities SET status = 'archived' WHERE name LIKE 'plain-%'");
      expect(computePatterns(getDatabase()).workflow.totalCommits).toBe(0);
    });

    it('does not count a forgotten decision even when it sits in a week that was compressed', () => {
      seedOldCommits();
      remember({ name: 'd-old', type: 'decision', why: 'a placeholder choice; revisit if the test changes', observations: ['x'] });
      getDatabase().exec("UPDATE entities SET created_at = datetime('now', '-10 days', '+3 hours') WHERE name = 'd-old'");
      compressWeeklyNoise(getDatabase());
      forget({ name: 'd-old' });
      expect(scheduleTotal()).toBe(25);
    });

    it('does not count anything else that was archived, such as a forgotten decision', () => {
      remember({ name: 'd-keep', type: 'decision', why: 'a placeholder choice; revisit if the test changes', observations: ['x'] });
      remember({ name: 'd-gone', type: 'decision', why: 'a placeholder choice; revisit if the test changes', observations: ['x'] });
      forget({ name: 'd-gone' });
      expect(scheduleTotal()).toBe(1);
    });
  });
});
