import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeRecency, formatAge } from '../../dashboard/src/components/GraphTab';
import { t } from '../../dashboard/src/lib/i18n';

afterEach(() => vi.restoreAllMocks());

describe('graph timestamp display', () => {
  it('treats SQLite UTC and ISO instants identically at the day boundary', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T10:17:01.618Z'));
    expect(formatAge('2026-09-07 11:00:00')).toBe(t('graph.ageToday'));
    expect(computeRecency('2026-09-07 11:00:00')).toBe(computeRecency('2026-09-07T11:00:00Z'));
  });

  it('preserves explicit offsets and missing recency', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T10:17:01.618Z'));
    expect(formatAge('2026-09-07T11:00:00+08:00')).toBe(t('graph.ageDaysAgo', { count: 1 }));
    expect(computeRecency(undefined)).toBe(0.15);
  });
});
