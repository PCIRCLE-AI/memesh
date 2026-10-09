import { describe, expect, it } from 'vitest';
import { briefingTaskStateLines, mergeTaskState, parseTaskState, taskStateLines } from '../../src/core/task-state.js';
import { boundTaskStateLines } from '../../src/core/work-topology.js';

const NOW = '2026-10-07T08:00:00.000Z';
const OLD = '2026-09-29T08:00:00.000Z';
const now = new Date(NOW);
const read = (raw: Record<string, unknown>) => parseTaskState({ task_state: raw });

describe('#406 each task-state field keeps its stated date', () => {
  it('stamps all initially stated fields', () => {
    const { state } = mergeTaskState({}, { goal: 'new goal', next: 'new step', blocked: 'waiting', done: 'old release' }, NOW);
    expect(state).toMatchObject({ updated_at: NOW, stated_at: { goal: NOW, next: NOW, blocked: NOW, done: NOW } });
  });

  it('a new goal preserves legacy dates and does not inject old done/next/blocked as fresh', () => {
    const previous = { goal: 'old goal', next: 'old step', blocked: 'old blocker', done: 'old release', updated_at: OLD };
    const { state } = mergeTaskState(previous, { goal: 'new goal' }, NOW);
    expect(state).toMatchObject({ next: 'old step', blocked: 'old blocker', done: 'old release',
      legacy_updated_at: OLD, stated_at: { goal: NOW } });
    expect(state.stated_at).toEqual({ goal: NOW });
    expect(read(state)).toEqual(state);
    const injected = briefingTaskStateLines(state, 'alpha', now).join('\n');
    expect(injected).toContain('new goal');
    expect(injected).not.toContain('old release');
    expect(injected).not.toContain('old step');
    expect(injected).not.toContain('old blocker');
    expect(injected).toContain('not shown as current');
    const full = taskStateLines(state, 'alpha', now).join('\n');
    expect(full).toContain('Had just finished:');
    expect(full).toContain('old release');
    expect(full).toContain('unknown date');
  });

  it('a recent legacy shared date cannot make an untouched done fresh', () => {
    const yesterday = '2026-10-06T08:00:00.000Z';
    const { state } = mergeTaskState({ goal: 'yesterday goal', done: 'ten-days-old work', updated_at: yesterday }, { goal: 'today goal' }, NOW);
    expect(state).toMatchObject({ done: 'ten-days-old work', legacy_updated_at: yesterday });
    expect(state.stated_at).toEqual({ goal: NOW });
    expect(briefingTaskStateLines(state, 'alpha', now).join('\n')).not.toContain('ten-days-old work');
    expect(taskStateLines(state, 'alpha', now).join('\n')).toContain('Had just finished: (unknown date) ten-days-old work');
    const nextWrite = mergeTaskState(state, { next: 'new step' }, '2026-10-08T08:00:00Z').state;
    expect(nextWrite.legacy_updated_at).toBe(yesterday);
    expect(read(nextWrite)).toEqual(nextWrite);
  });

  it('does not echo malformed legacy provenance', () => {
    expect(read({ goal: 'goal', legacy_updated_at: 'arbitrary untrusted text' }).legacy_updated_at).toBeUndefined();
  });

  it('does not guess a missing legacy date from a new goal', () => {
    const { state } = mergeTaskState({ done: 'undated work' }, { goal: 'new goal' }, NOW);
    expect(state).toMatchObject({ done: 'undated work', stated_at: { goal: NOW } });
    expect(briefingTaskStateLines(state, 'alpha', now).join('\n')).not.toContain('undated work');
    expect(taskStateLines(state, 'alpha', now).join('\n')).toContain('unknown date');
  });

  it('same-value restatement is a no-op and does not mutate prior dates', () => {
    const previous = read({ goal: 'goal', done: 'done', updated_at: NOW, stated_at: { goal: NOW, done: OLD } });
    Object.freeze(previous.stated_at);
    const result = mergeTaskState(previous, { goal: 'goal' }, '2026-10-08T08:00:00Z');
    expect(result.changed).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(result.state).toEqual(previous);
  });

  it('clearing a field removes its date but leaves other fields and dates unchanged', () => {
    const previous = read({ goal: 'goal', done: 'done', updated_at: OLD, stated_at: { goal: OLD, done: OLD } });
    const { state } = mergeTaskState(previous, { done: '' }, NOW);
    expect(state.done).toBeUndefined();
    expect(state).toMatchObject({ goal: 'goal', stated_at: { goal: OLD }, updated_at: NOW });
    expect(state.stated_at?.done).toBeUndefined();
    expect(previous.stated_at?.done).toBe(OLD);
    expect(briefingTaskStateLines(state, 'alpha', now).join('\n')).not.toContain('Goal: goal');
  });

  it('does not migrate a legacy record on an unchanged write', () => {
    const previous = { goal: 'goal', updated_at: OLD };
    expect(mergeTaskState(previous, { goal: 'goal' }, NOW).state).toEqual(previous);
  });

  it('parses only known dates belonging to present fields', () => {
    expect(read({ goal: 'goal', done: 'done', stated_at: { goal: NOW, done: 7, blocked: OLD, extra: NOW } }))
      .toEqual({ goal: 'goal', done: 'done', stated_at: { goal: NOW } });
  });

  it.each([{ stated_at: null }, { stated_at: 7 }, { stated_at: [] }])('a malformed date map does not fall back to a fresh record timestamp: %j', ({ stated_at }) => {
    const state = read({ done: 'old work', updated_at: NOW, stated_at });
    expect(briefingTaskStateLines(state, 'alpha', now).join('\n')).not.toContain('old work');
    expect(briefingTaskStateLines(state, 'alpha', now).join('\n')).toContain('age could not be established');
  });

  it.each([undefined, 'not-a-date', '2026-10-07', '2026-10-07T08:00:00', '2026-10-08T08:00:00Z'])('an unknown or future field date is not refreshed by updated_at: %s', (date) => {
      const state = read({ goal: 'fresh goal', done: 'old work', updated_at: NOW,
        stated_at: { goal: NOW, ...(date === undefined ? {} : { done: date }) } });
      const lines = briefingTaskStateLines(state, 'alpha', now).join('\n');
      expect(lines).toContain('fresh goal');
      expect(lines).not.toContain('old work');
      expect(lines).toContain('not shown as current');
    });

  it('judges the 72-hour boundary separately for each field', () => {
    const state = read({ goal: 'fresh goal', done: 'expired work', updated_at: NOW,
      stated_at: { goal: '2026-10-04T08:00:00.000Z', done: '2026-10-04T07:59:59.999Z' } });
    const lines = briefingTaskStateLines(state, 'alpha', now).join('\n');
    expect(lines).toContain('fresh goal');
    expect(lines).not.toContain('expired work');
  });

  it('accepts ordinary clock skew without accepting a distant future field', () => {
    const state = read({ goal: 'goal', done: 'future work', updated_at: NOW,
      stated_at: { goal: '2026-10-07T08:05:00Z', done: '2026-10-07T08:05:01Z' } });
    const lines = briefingTaskStateLines(state, 'alpha', now).join('\n');
    expect(lines).toContain('Goal:');
    expect(lines).toContain(' goal');
    expect(lines).not.toContain('future work');
  });

  it('minimal hides fresh values but still reports omitted old fields', () => {
    const state = read({ goal: 'fresh goal', done: 'old work', updated_at: NOW, stated_at: { goal: NOW, done: OLD } });
    const lines = briefingTaskStateLines(state, 'alpha', now, { includeFresh: false }).join('\n');
    expect(lines).not.toContain('fresh goal');
    expect(lines).not.toContain('old work');
    expect(lines).toContain('not shown as current');
  });

  it('uses the newest actual field date for an entirely stale state', () => {
    const state = read({ goal: 'old goal', done: 'older work', updated_at: NOW,
      stated_at: { goal: OLD, done: '2026-09-25T08:00:00Z' } });
    const lines = briefingTaskStateLines(state, 'alpha', now);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('8 days ago');
    expect(lines[0]).not.toContain('old goal');
  });

  it('keeps the stated date visible when a long done line is bounded for injection', () => {
    const state = read({ done: 'x'.repeat(300), updated_at: NOW, stated_at: { done: NOW } });
    const lines = boundTaskStateLines(briefingTaskStateLines(state, 'alpha', now));
    expect(lines.join('\n')).toContain(NOW);
    expect(lines.join('\n')).toContain('today');
  });

  it('redacts a credential across the full stored field set before omitting an old field', () => {
    const marker = 'split-password-fixture';
    const state = read({ goal: marker, done: ['-----END ', 'PRIVATE KEY-----'].join(''), updated_at: NOW,
      stated_at: { goal: NOW, done: OLD } });
    const text = briefingTaskStateLines(state, 'alpha', now).join('\n');
    expect(text).not.toContain(marker);
    expect(text).toContain('REDACTED');
  });
});
