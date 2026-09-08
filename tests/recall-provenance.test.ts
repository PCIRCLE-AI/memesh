import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Recall results label FTS5 matches; an empty-query listing is not a match. */
let home: string;
let prevHome: string | undefined;
let prevProfile: string | undefined;

describe('recall provenance: results say how they were found', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-prov-'));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/db.js');
    closeDatabase();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('keyword hits are tagged keyword and nonsense does not surface unrelated rows', async () => {
    const { openDatabase } = await import('../src/db.js');
    const { remember, recallEnhanced } = await import('../src/core/operations.js');
    openDatabase();

    await remember({
      name: 'lorem-note',
      type: 'note',
      observations: ['lorem-ipsum-token lorem-ipsum-token dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'],
    });

    const { entities: keyword } = await recallEnhanced({ query: 'lorem ipsum dolor' });
    expect(keyword.length).toBeGreaterThan(0);
    expect(keyword[0].match?.source).toBe('keyword');

    const { entities: nonsense } = await recallEnhanced({ query: 'xyzzyplughfrobozz quux' });
    expect(nonsense).toEqual([]);
  });

  it('the empty-query listing carries no match provenance — a listing is not a match', async () => {
    const { openDatabase } = await import('../src/db.js');
    const { remember, recallEnhanced } = await import('../src/core/operations.js');
    openDatabase();
    await remember({ name: 'plain-note', type: 'note', observations: ['hello world'] });

    const listed = (await recallEnhanced({})).entities;
    expect(listed.length).toBeGreaterThan(0);
    for (const e of listed) expect(e.match).toBeUndefined();
  });
});
