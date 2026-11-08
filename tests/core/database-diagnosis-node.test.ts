import { describe, it, expect } from 'vitest';
import { diagnoseDatabaseFailure } from '../../src/core/database-diagnosis.js';
import { tooOldError } from '../helpers/node-floor.js';

describe('Feature: diagnosing a database that will not open on a Node below the floor', () => {
  it('names the Node, and the fix is to upgrade it, not to move the database aside', () => {
    const err = tooOldError();
    const existing = diagnoseDatabaseFailure(err, '/x/db', () => true, (() => ({ mode: 0o100600, size: 4096 })) as never);
    const missing = diagnoseDatabaseFailure(err, '/x/db', () => false);
    for (const d of [existing, missing]) {
      expect(d.diagnosis).toBe(err.message);
      expect(d.fix).toContain('22.16');
      expect(d.fix).not.toMatch(/mv |rm |Backup and reset|mkdir|chmod/);
    }
  });
});
