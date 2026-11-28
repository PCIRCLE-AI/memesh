import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProvider } from '../../src/core/hermes-provider.js';
import * as identity from '../../src/core/process-identity.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-staging-safety-'));
  roots.push(root);
  const sourceDir = path.join(root, 'source');
  const target = path.join(root, 'plugins', 'memesh');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, '__init__.py'), '# original provider\n');
  fs.writeFileSync(path.join(sourceDir, 'plugin.yaml'), 'name: memesh\n');
  const input = { sourceDir, target, version: '1.0.0', backupRoot: path.join(root, 'backups'), now: new Date(), force: false };
  expect(installProvider(input).outcome).toBe('installed');
  const previous = fs.readFileSync(path.join(target, '__init__.py'), 'utf8');
  fs.writeFileSync(path.join(sourceDir, '__init__.py'), '# replacement provider\n');
  return { target, previous, input: { ...input, version: '2.0.0' } };
}
const aside = (target: string, kind: string, pid: number, tag: string) =>
  path.join(path.dirname(target), `.memesh-${kind}-memesh-${pid}-${tag}`);

describe('Hermes staging ownership', () => {
  for (const kind of ['new', 'old']) {
    it(`preserves a live current-owner ${kind} staging directory and refuses replacement`, () => {
      const f = fixture();
      const start = identity.processStartTag(process.pid);
      const tag = start === null ? 'x' : createHash('sha256').update(start).digest('hex').slice(0, 10);
      const staging = aside(f.target, kind, process.pid, tag);
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(staging, 'sentinel'), 'live owner data');
      const result = installProvider(f.input);
      expect(result).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('EEXIST') });
      expect(fs.readFileSync(path.join(staging, 'sentinel'), 'utf8')).toBe('live owner data');
      expect(fs.readFileSync(path.join(f.target, '__init__.py'), 'utf8')).toBe(f.previous);
      if (kind === 'old') expect(fs.existsSync(aside(f.target, 'new', process.pid, tag))).toBe(false);
    });
  }

  it('preserves a live owner with an unknown start tag', () => {
    const f = fixture();
    vi.spyOn(identity, 'processStartTag').mockReturnValue(null);
    const staging = aside(f.target, 'new', process.pid, 'x');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'sentinel'), 'unknown start is not dead');
    expect(installProvider(f.input)).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('EEXIST') });
    expect(fs.readFileSync(path.join(staging, 'sentinel'), 'utf8')).toBe('unknown start is not dead');
    expect(fs.readFileSync(path.join(f.target, '__init__.py'), 'utf8')).toBe(f.previous);
  });

  it('still restores a copy left by a real exited owner and completes the refresh', () => {
    const f = fixture();
    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    const oldRoot = aside(f.target, 'old', child.pid, 'x');
    const newRoot = aside(f.target, 'new', child.pid, 'x');
    fs.mkdirSync(oldRoot);
    fs.renameSync(f.target, path.join(oldRoot, 'copy'));
    fs.mkdirSync(newRoot);
    fs.writeFileSync(path.join(newRoot, 'sentinel'), 'abandoned staging');
    expect(installProvider(f.input)).toMatchObject({ outcome: 'refreshed', reason: expect.stringContaining('interrupted') });
    expect(fs.readFileSync(path.join(f.target, '__init__.py'), 'utf8')).toBe('# replacement provider\n');
    expect(fs.existsSync(oldRoot)).toBe(false);
    expect(fs.existsSync(newRoot)).toBe(false);
  });
});
