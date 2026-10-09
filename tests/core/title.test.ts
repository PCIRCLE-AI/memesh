import { describe, it, expect } from 'vitest';
import { truncateTitle, TITLE_MAX_LENGTH } from '../../src/core/title.js';

describe('title truncation', () => {
  it.each([197, 198, 199])('keeps the whole emoji at the title boundary after %i characters', count => {
    const prefix = 'a'.repeat(count);
    const title = truncateTitle(prefix + '😀' + 'b'.repeat(30));
    expect(title).toBe(count === 197 ? prefix + '😀…' : prefix + '…');
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(Buffer.from(title).toString('utf8')).toBe(title);
  });
});
