import { describe, expect, it } from 'vitest';
import { isDoctorFixPermissionError } from '../../src/core/doctor-fixes.js';

describe('doctor repair permission failure classification', () => {
  it.each(['EACCES', 'EPERM', 'EROFS'])('recognizes direct %s filesystem failures', (code) => {
    expect(isDoctorFixPermissionError(Object.assign(new Error('fixture path must stay private'), { code }))).toBe(true);
  });

  it('recognizes the owned plugin script failure when its lock parent is not writable', () => {
    const error = Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: 'ERROR: could not create the upgrade lock at /fixture/private/cache.lock.\nIts parent must exist and be writable.',
    });
    expect(isDoctorFixPermissionError(error)).toBe(true);
  });

  it('does not misclassify contention or unrelated child-process failures', () => {
    expect(isDoctorFixPermissionError(Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: 'ERROR: could not acquire the upgrade lock — another upgrade may be running.',
    }))).toBe(false);
    expect(isDoctorFixPermissionError(new Error('unexpected parser failure'))).toBe(false);
  });
});
