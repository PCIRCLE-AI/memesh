import { describe, expect, it } from 'vitest';
import { relativeDate, timeBucket, timestampDate } from '../../dashboard/src/lib/entity-display';

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
