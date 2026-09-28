import { describe, expect, it } from 'vitest';
import { projectChipLabels, relativeDate, shortProjectId, timeBucket, timestampDate } from '../../dashboard/src/lib/entity-display';

describe('dashboard entity timestamp display', () => {
  const now = new Date('2026-09-08T10:17:01.618Z');

  it('treats SQLite UTC timestamps as UTC for relative dates and buckets', () => {
    // Run with TZ=Asia/Taipei: native parsing previously returned eight hours.
    expect(relativeDate('2026-09-08 10:10:25', now)).toBe('Just now');
    expect(timeBucket('2026-09-07 11:00:00', now)).toBe('today');
  });

  it('keeps explicitly zoned ISO timestamps on their declared instant', () => {
    expect(relativeDate('2026-09-08T10:10:25.000Z', now)).toBe('Just now');
    expect(relativeDate('2026-09-08T10:10:25+08:00', now)).toBe('8h ago');
  });

  it('preserves invalid-date fallbacks', () => {
    expect(relativeDate('not-a-date', now)).toBe('—');
    expect(timeBucket('not-a-date', now)).toBe('older');
  });
  it('gives absolute dates and capture buckets the same UTC instant', () => {
    expect(timestampDate('2026-09-08 10:10:25').toISOString()).toBe('2026-09-08T10:10:25.000Z');
    expect(timestampDate('2026-09-08T18:10:25+08:00').toISOString()).toBe('2026-09-08T10:10:25.000Z');
  });
});

// #493 — the chip text a project id renders as at phone width, where a raw
// id (its 32-hex routing hash has no break opportunity) forces the Project
// and Memories tabs to scroll sideways.
describe('projectChipLabels — chip text for a list of project ids', () => {
  const HASH_A = '2c0fe491888c8efb9a4894828bbc2733';
  const HASH_B = 'aa11bb22cc33dd44ee55ff6600112233';

  it('strips the routing hash and adds no suffix when the label is already unique', () => {
    const labels = projectChipLabels([`memesh-llm-memory~${HASH_A}`, 'other-project']);
    expect(labels.get(`memesh-llm-memory~${HASH_A}`)).toEqual({ base: 'memesh-llm-memory', suffix: undefined });
    expect(labels.get('other-project')).toEqual({ base: 'other-project', suffix: undefined });
  });

  it('leaves an id with no hash exactly as projectLabel would (unchanged, no suffix)', () => {
    const labels = projectChipLabels(['plain-project']);
    expect(labels.get('plain-project')).toEqual({ base: 'plain-project', suffix: undefined });
  });

  // The real #493 data: the same repository shows up as `memesh~<hash>`
  // (from a project: tag) and bare `memesh` (from a git remote) — the
  // #408 three-identities split, deliberately NOT the fix here. Both stay
  // separate chips; only the hashed one needs a suffix to stay tellable
  // apart from the plain one, because the plain one is already short and
  // unambiguous on its own.
  it('adds a 6-hex suffix to a hashed id only when it collides with another id\'s label', () => {
    const ids = [`memesh~${HASH_A}`, 'memesh', 'memesh-llm-memory'];
    const labels = projectChipLabels(ids);
    expect(labels.get(`memesh~${HASH_A}`)).toEqual({ base: 'memesh', suffix: '2c0fe4' });
    expect(labels.get('memesh')).toEqual({ base: 'memesh', suffix: undefined });
    expect(labels.get('memesh-llm-memory')).toEqual({ base: 'memesh-llm-memory', suffix: undefined });
  });

  it('gives two different hashed ids that collide on label two different suffixes', () => {
    const ids = [`repo~${HASH_A}`, `repo~${HASH_B}`];
    const labels = projectChipLabels(ids);
    expect(labels.get(`repo~${HASH_A}`)).toEqual({ base: 'repo', suffix: '2c0fe4' });
    expect(labels.get(`repo~${HASH_B}`)).toEqual({ base: 'repo', suffix: 'aa11bb' });
  });

  it('is keyed by the full, untouched id — never the shortened label', () => {
    const labels = projectChipLabels([`repo~${HASH_A}`]);
    expect(labels.has('repo')).toBe(false);
    expect(labels.has(`repo~${HASH_A}`)).toBe(true);
  });
});

describe('shortProjectId (one project shown alone, #493)', () => {
  it('keeps a 6-hex suffix on a hashed id so two same-label projects stay apart', () => {
    expect(shortProjectId('memesh~2c0fe491888c8efb9a4894828bbc2733')).toBe('memesh~2c0fe4');
    expect(shortProjectId('memesh~9a4894828bbc27332c0fe491888c8efb')).toBe('memesh~9a4894');
  });

  it('leaves an id without a routing hash unchanged', () => {
    expect(shortProjectId('memesh')).toBe('memesh');
    expect(shortProjectId('my-app~v2')).toBe('my-app~v2');
  });
});
