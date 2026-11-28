/**
 * The test runner removes its throwaway HOME when it ends. A hook under test can still have a background process
 * writing into it, so losing that race is not a failed run, but it must not be silent either: the leftover folder
 * is named in a warning. Any other failure is a real one and still throws.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempHome } from '../scripts/lib/remove-temp-home.mjs';

const failing = (code: string) => () => { throw Object.assign(new Error(`${code}: simulated`), { code }); };

describe('removeTempHome', () => {
  it('removes the folder and says nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-remove-home-'));
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    const warnings: string[] = [];
    expect(removeTempHome(dir, { warn: (l: string) => warnings.push(l) })).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it.each(['ENOTEMPTY', 'EBUSY', 'EPERM'])('%s: the run is not failed, and the warning names the folder that was left', (code) => {
    const warnings: string[] = [];
    expect(removeTempHome('/tmp/memesh-test-home-left', { rm: failing(code), warn: (l: string) => warnings.push(l) })).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/tmp/memesh-test-home-left');
    expect(warnings[0]).toContain(code);
    // It cannot know WHY (macOS also reports a permission problem as ENOTEMPTY): it must not claim a cause, and
    // it carries the error's own message so the real cause can be read.
    expect(warnings[0]).toContain('may still have been writing, or something under it could not be removed');
    expect(warnings[0]).toContain('simulated');
  });

  it('any other error still throws', () => {
    expect(() => removeTempHome('/tmp/x', { rm: failing('EACCES'), warn: () => undefined })).toThrow(/EACCES/);
  });
});
