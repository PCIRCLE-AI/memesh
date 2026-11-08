/**
 * The Node floor: node:sqlite has FTS5 only from 22.16.0 (nodejs/node#57621).
 * Below it every open failed with `no such module: fts5`; now it is refused
 * with one sentence that names the fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import { MIN_NODE_VERSION, MemeshDatabase, fts5ProbeResult, UnsupportedNodeError, nodeSupportProblem } from '../../src/storage/sqlite.js';

const yes = () => true;

describe('Feature: the Node floor check', () => {
  it('floor is 22.16.0 and matches package.json engines', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(MIN_NODE_VERSION).toBe('22.16.0');
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_VERSION}`);
  });

  it.each(['22.13.0', '22.14.0', '22.15.0', '22.15.1', '21.9.0', '20.19.0', 'garbage'])('rejects %s', (version) => {
    expect(nodeSupportProblem(version, yes)).not.toBeNull();
  });

  it.each(['22.16.0', '22.16.1', '22.23.4', '24.0.0', '26.5.1', 'v22.16.0'])('accepts %s', (version) => {
    expect(nodeSupportProblem(version, yes)).toBeNull();
  });

  it('the message names 22.16, says upgrade, and is a single sentence', () => {
    const msg = nodeSupportProblem('22.15.1', yes) ?? '';
    expect(msg).toContain('22.16');
    expect(msg).toContain('v22.15.1');
    expect(msg).toMatch(/upgrade/i);
    expect(msg).toMatch(/full-text search/);
    // one sentence: once version numbers are set aside, the only full stop is the last character
    const bare = msg.replace(/\d+(\.\d+)+/g, 'N');
    expect(bare.indexOf('.')).toBe(bare.length - 1);
  });

  it('a new-enough Node built without FTS5 is refused too, naming 22.16', () => {
    const msg = nodeSupportProblem('24.0.0', () => false) ?? '';
    expect(msg).toContain('FTS5');
    expect(msg).toContain('22.16');
  });

  describe('the FTS5 probe', () => {
    it('is true when the statement works', () => {
      expect(fts5ProbeResult(() => undefined)).toBe(true);
    });
    it('is false only for SQLite\'s own "no such module"', () => {
      expect(fts5ProbeResult(() => { throw new Error('no such module: fts5'); })).toBe(false);
    });
    it('any other failure is thrown as itself, not read as a missing FTS5', () => {
      expect(() => fts5ProbeResult(() => { throw new Error('out of memory'); })).toThrow('out of memory');
    });
  });

  describe('opening a database', () => {
    const real = process.versions.node;
    afterEach(() => {
      Object.defineProperty(process.versions, 'node', { value: real, configurable: true });
    });

    it('throws UnsupportedNodeError (code NODE_TOO_OLD) on 22.15.1 and opens on 22.16.0', () => {
      Object.defineProperty(process.versions, 'node', { value: '22.15.1', configurable: true });
      let caught: unknown;
      try { new MemeshDatabase(':memory:'); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(UnsupportedNodeError);
      expect((caught as UnsupportedNodeError).code).toBe('NODE_TOO_OLD');
      expect((caught as Error).message).toContain('22.16');

      Object.defineProperty(process.versions, 'node', { value: '22.16.0', configurable: true });
      new MemeshDatabase(':memory:').close();
    });
  });
});
